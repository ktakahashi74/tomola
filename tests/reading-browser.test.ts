import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { entries, profiles, rateLimits, readingCounts, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { action } from "~/routes/topic-translations";
import { TRANSLATION_READ_CALLS_HOURLY } from "~/lib/translation-on-read.server";
import { hitRateLimit } from "~/lib/rate-limit.server";
import { setTestLocale } from "./stubs/paraglide-runtime";

let h: RouteHarness;
afterEach(() => { h?.restore(); vi.unstubAllEnvs(); setTestLocale("en"); });
async function seed() {
  h = await setupRouteHarness();
  vi.stubEnv("PUBLIC_READING", "1");
  await h.signIn("readsource");
  await h.signIn("readvisitor");
  const result = await createTopic(h.db, h.ids.readsource, { lang: "ja", title: "Reading", body: "読む。" });
  if (!result.ok) throw new Error(result.error);
  const [topic] = await h.db.select().from(entries).where(eq(entries.id, result.id));
  await h.db.insert(translations).values({ entryId: result.id, lang: "en", field: "body", kind: "primary", text: "Read.", sourceHash: topic.sourceHash, engine: "fake" });
  return result.id;
}
function post(id: number, search: string, opts: { intent?: "read" | "seen"; ids?: number[]; as?: string; internal?: boolean; shared?: boolean; referrerHost?: string; headers?: Record<string, string> } = {}) {
  const base = h.request(`/t/${id}/translations${search}`, { as: opts.as });
  const headers = new Headers(base.headers);
  Object.entries({ origin: "http://localhost:5173", referer: `http://localhost:5173/t/${id}${search}`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...opts.headers }).forEach(([key, value]) => headers.set(key, value));
  return action(h.args(new Request(base.url, { method: "POST", headers, body: JSON.stringify({ intent: opts.intent ?? "read", ids: opts.ids ?? [], internal: opts["internal"] ?? false, shared: opts.shared ?? new URLSearchParams(search).has("sl"), referrerHost: opts.referrerHost ?? "" }) }), { id: String(id) }));
}
it("derives source and displayed languages server-side, separates shares and internal reads, and ignores reply pagination", async () => {
  const id = await seed();
  await post(id, "?lang=en", { shared: true, referrerHost: "google.com" });
  await post(id, "?lang=en&sl=en", { internal: true, referrerHost: "google.com" });
  await post(id, "?lang=en&sl=en", { shared: false, referrerHost: "google.com" });
  await post(id, `?lang=en&orig=${id}`, { referrerHost: "claude.ai" });
  await post(id, "?lang=fr"); // The translation is missing, so the source is shown.
  const rows = await h.db.select().from(readingCounts);
  expect(rows.find(row => row.source === "share_link")).toMatchObject({ sourceLang: "ja", readLang: "en", count: 1 });
  expect(rows.find(row => row.source === "internal")).toMatchObject({ readLang: "en", count: 1 });
  expect(rows.find(row => row.source === "search")).toMatchObject({ readLang: "en", count: 1 });
  expect(rows.find(row => row.source === "ai")).toMatchObject({ readLang: "ja", count: 1 });
  expect(rows.find(row => row.readLang === "ja" && row.count === 1 && row.source === "none")).toBeDefined();
  expect(rows.some(row => row.readLang === "fr")).toBe(false);
  const [tr] = await h.db.select().from(translations).where(eq(translations.entryId, id));
  expect(tr.everSeen).toBe(false);
  expect(tr.firstSeenAt).toBeNull();
  // Keep the existing display-report behavior independently of read counting.
  await post(id, "?lang=en", { intent: "seen", ids: [tr.id], headers: { "user-agent": "Google-Extended" } });
  const [seen] = await h.db.select().from(translations).where(eq(translations.id, tr.id));
  expect(seen.everSeen).toBe(true);
  expect(seen.firstSeenAt).not.toBeNull();
  await h.db.insert(entries).values(Array.from({ length: 101 }, () => ({ kind: "reply", threadId: id, authorId: h.ids.readsource, lang: "ja", body: "Reply page fixture" })));
  await post(id, "?lang=en&page=2");
  expect(await h.db.select().from(readingCounts)).toEqual(rows);
});
it("excludes the author and excluded members and rejects bots, foreign requests and rate-limited reports", async () => {
  const id = await seed();
  await post(id, "?lang=en", { as: "readsource" });
  await h.db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, h.ids.readvisitor));
  await post(id, "?lang=en", { as: "readvisitor" });
  expect((await h.db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
  for (const headers of [{ "user-agent": "GPTBot" }, { "user-agent": "Google-Extended" }, { origin: "https://outside.example" }] as Record<string, string>[]) {
    expect(await h.outcome(() => post(id, "?lang=en", { headers }))).toMatchObject({ status: 403 });
  }
  await h.db.delete(rateLimits);
  await hitRateLimit(h.db, { key: "translation-read-calls:unknown", limit: TRANSLATION_READ_CALLS_HOURLY, windowSeconds: 3600, cost: TRANSLATION_READ_CALLS_HOURLY });
  expect(await h.outcome(() => post(id, "?lang=en"))).toMatchObject({ status: 429 });
  expect((await h.db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
});
