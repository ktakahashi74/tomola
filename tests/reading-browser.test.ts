import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { entries, entryReadingCounts, profiles, rateLimits, readingCounts, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { loader as topicLoader } from "~/routes/topic";
import { loader as adminLoader } from "~/routes/admin-metrics";
import { EXCLUDED_RESIDENCE_COUNTRIES } from "./helpers/operator";
import { DELETED_MEMBER_ID, DELETED_MEMBER_EMAIL } from "~/lib/deleted-member";
import { user } from "~/lib/db/schema";
import { signReadingMark } from "~/lib/reading-mark.server";
import { action } from "~/routes/topic-translations";
import { TRANSLATION_READ_CALLS_HOURLY } from "~/lib/translation-on-read.server";
import { hitMemoryReadLimit, hitRateLimit } from "~/lib/rate-limit.server";
import { setTestLocale } from "./stubs/paraglide-runtime";

let h: RouteHarness;
afterEach(() => { h?.restore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setTestLocale("en"); });
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
function post(id: number, search: string, opts: { intent?: "read" | "seen" | "status" | "request"; ids?: number[]; as?: string; internal?: boolean; shared?: boolean; referrerHost?: string; mark?: string; shown?: "original" | "translation"; headers?: Record<string, string> } = {}) {
  const base = h.request(`/t/${id}/translations${search}`, { as: opts.as });
  const headers = new Headers(base.headers);
  Object.entries({ origin: "http://localhost:5173", referer: `http://localhost:5173/t/${id}${search}`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...opts.headers }).forEach(([key, value]) => headers.set(key, value));
  return action(h.args(new Request(base.url, { method: "POST", headers, body: JSON.stringify({ intent: opts.intent ?? "read", ids: opts.ids ?? [], internal: opts["internal"] ?? false, shared: opts.shared ?? new URLSearchParams(search).has("sl"), referrerHost: opts.referrerHost ?? "", mark: opts.mark, shown: opts.shown }) }), { id: String(id) }));
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
  for (const headers of [{ "user-agent": "GPTBot" }, { "user-agent": "Meta-ExternalFetcher" }, { origin: "https://outside.example" }] as Record<string, string>[]) {
    expect(await h.outcome(() => post(id, "?lang=en", { headers }))).toMatchObject({ status: 403 });
  }
  await h.db.delete(rateLimits);
  for (let i = 0; i < TRANSLATION_READ_CALLS_HOURLY; i++) hitMemoryReadLimit(h.db, "translation-read-calls:unknown", { limit: TRANSLATION_READ_CALLS_HOURLY, windowSeconds: 3600 });
  expect(await h.outcome(() => post(id, "?lang=en"))).toMatchObject({ status: 429 });
  expect((await h.db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
});

it("limits anonymous read notifications in memory without storing IPs and preserves translation intent limits", async () => {
  const id = await seed();
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  const headers = { "x-forwarded-for": "192.0.2.41" };
  await h.db.delete(rateLimits);
  await post(id, "?lang=ja", { headers });
  expect(await h.db.select().from(rateLimits)).toEqual([]);
  const rule = { limit: TRANSLATION_READ_CALLS_HOURLY, windowSeconds: 3600 };
  for (let i = 1; i < rule.limit; i++) hitMemoryReadLimit(h.db, "ip:translation-read-calls:192.0.2.41", rule);
  expect(await h.outcome(() => post(id, "?lang=ja", { headers }))).toMatchObject({ status: 429 });
  expect(await h.db.select().from(rateLimits)).toEqual([]);
  expect(await h.outcome(() => post(id, "?lang=ja", { headers: { "x-forwarded-for": "192.0.2.42" } }))).toMatchObject({ status: 200 });
  await post(id, "?lang=ja", { as: "readvisitor", headers });
  expect(await h.db.select().from(rateLimits)).toEqual([]);
  // The read counter does not spend or replace translation call limits.
  for (const intent of ["seen", "status", "request"] as const) {
    await h.db.delete(rateLimits);
    await post(id, "?lang=en", { intent, headers });
    expect((await h.db.select().from(rateLimits)).map(row => row.key)).toContain("ip:translation-read-calls:192.0.2.41");
    await hitRateLimit(h.db, { key: "ip:translation-read-calls:192.0.2.41", ...rule, cost: rule.limit });
    expect(await h.outcome(() => post(id, "?lang=en", { intent, headers }))).toMatchObject({ status: 429 });
  }
});

it("uses the loader's signed display after an edit and verifies unsigned, expired, and altered notifications", async () => {
  const id = await seed();
  const search = `?lang=en&tr=${id}`;
  const { readingMark } = await topicLoader(h.args(h.request(`/t/${id}${search}`), { id: String(id) }));
  expect(readingMark).toBeTruthy();
  await h.db.update(entries).set({ lang: "de" }).where(eq(entries.id, id));
  await h.db.delete(translations).where(eq(translations.entryId, id));
  expect(await post(id, search, { mark: readingMark!, shown: "translation" })).toMatchObject({ data: { ok: true, counted: true } });
  const expired = signReadingMark(id, { sourceLang: "ja", readLang: "en", isTranslated: true }, Date.now() - 16 * 60_000);
  const wrongArticle = signReadingMark(id + 1, { sourceLang: "ja", readLang: "en", isTranslated: true });
  for (const mark of [undefined, expired, wrongArticle, readingMark! + ".extra"]) {
    expect(await post(id, search, { mark, shown: "translation" })).toMatchObject({ data: { ok: true, counted: true } });
  }
  expect(await post(id, search, { mark: readingMark!, shown: "original" })).toMatchObject({ data: { ok: true, counted: true } });
  expect((await h.db.select().from(entryReadingCounts)).map(({ isTranslated, count }) => [isTranslated, count])).toEqual(expect.arrayContaining([[true, 1], [false, 5]]));
  expect((await h.db.select().from(readingCounts)).filter(row => row.count)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceLang: "ja", readLang: "en", count: 1 }),
    expect.objectContaining({ sourceLang: "de", readLang: "de", count: 5 }),
  ]));
});

it("rolls back the site-wide write on an article upsert failure and returns counted false", async () => {
  const id = await seed();
  await h.db.execute(sql`alter table entry_reading_counts add constraint fixture_reject_read check (count = 0)`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await post(id, "?lang=en", { shown: "translation" })).toMatchObject({ data: { ok: true, counted: false } });
  expect(await h.db.select().from(entryReadingCounts)).toEqual([]);
  expect((await h.db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
  expect(warn.mock.calls).toEqual([["[reading-counts] Could not count read"]]);
});

it("shares article counts only with eligible members and continues counting articles by a departed author", async () => {
  const id = await seed();
  const article = (as?: string) => topicLoader(h.args(h.request(`/t/${id}?lang=en`, { as }), { id: String(id) }));
  const stats = (as: string) => adminLoader(h.args(h.request("/admin/metrics", { as })));
  await h.db.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL });
  await h.db.update(entries).set({ authorId: DELETED_MEMBER_ID }).where(eq(entries.id, id));
  for (let i = 0; i < 5; i++) expect(await post(id, "?lang=en", { as: "readvisitor" })).toMatchObject({ data: { counted: true } });
  expect((await article("readvisitor")).articleViews).toMatchObject({ total: 5, translated: 5 });
  expect((await article()).articleViews).toBeNull();
  expect(await h.outcome(() => stats("readvisitor"))).toMatchObject({ status: 404 });
  vi.stubEnv("OPERATOR_EMAILS", "readsource@example.com");
  expect((await stats("readsource")).articleReadings.articles).toMatchObject([{ id, browser: 5, translated: 5 }]);
  for (const restriction of [
    { suspendedUntil: new Date(Date.now() + 86_400_000) },
    { suspendedUntil: null, residenceCountry: EXCLUDED_RESIDENCE_COUNTRIES[0] },
    { residenceCountry: "JP", trialConsentAt: null, trialConsentVersion: null },
  ]) {
    await h.db.update(profiles).set(restriction).where(eq(profiles.userId, h.ids.readvisitor));
    expect((await article("readvisitor")).articleViews).toBeNull();
  }
  await h.signIn("pendingread", { profile: false });
  expect(await h.outcome(() => article("pendingread"))).toMatchObject({ status: 302, location: "/onboarding" });
});
