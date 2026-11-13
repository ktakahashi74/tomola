import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { entries, jobs, llmUsage, profiles, rateLimits, roles, translations, villageFollows, villageMembers, villages } from "~/lib/db/schema";
import * as metering from "~/lib/llm/metering.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { enqueueTranslations, TRANSLATE_JOB, TITLE_TRANSLATE_JOB } from "~/lib/translations.server";
import { eagerBodyLangs } from "~/lib/translation-eager.server";
import { translationEagerConfig } from "~/lib/translation-eager-config.server";
import { markTranslationsSeen, requestBodyTranslations, translationReadStats, TRANSLATION_READ_CALLS_HOURLY } from "~/lib/translation-on-read.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { hitRateLimit, translationReadLimitKey } from "~/lib/rate-limit.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { action, loader } from "~/routes/topic-translations";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { translationPageInputs } from "~/lib/translation-on-read.server";
import { BUDGET_RESERVATION_WAIT } from "~/lib/jobs/defer-reasons";
import { translateDedupeKey } from "~/lib/translations.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setTestLocale("en"); });
async function setup() {
  vi.stubEnv("TRANSLATION_EAGER_SCOPE", "readers");
  const db = await createTestDb();
  await addMember(db, "source", "source_writer");
  await db.update(profiles).set({ displayLang: "ja" }).where(eq(profiles.userId, "source"));
  return db;
}
async function topic(db: Awaited<ReturnType<typeof createTestDb>>, title: string | null = "原題") {
  const result = await createTopic(db, "source", { lang: "ja", title, body: "本文。" });
  if (!result.ok) throw new Error(result.error);
  const [row] = await db.select().from(entries).where(eq(entries.id, result.id));
  return { ...row, kind: "topic" as const, lang: "ja" as const };
}
const queued = (db: Awaited<ReturnType<typeof createTestDb>>, kind: string) => db.select().from(jobs).where(eq(jobs.kind, kind));

it("validates the default reader policy and threshold at startup", () => {
  expect(translationEagerConfig({})).toEqual({ scope: "readers", minReaders: 1 });
  expect(translationEagerConfig({ TRANSLATION_EAGER_SCOPE: "all", TRANSLATION_EAGER_MIN_READERS: "3" })).toEqual({ scope: "all", minReaders: 3 });
  for (const value of ["0", "-1", "1.5", "Infinity", "9007199254740992", "one"]) expect(() => translationEagerConfig({ TRANSLATION_EAGER_MIN_READERS: value })).toThrow();
  expect(() => translationEagerConfig({ TRANSLATION_EAGER_SCOPE: "reader" })).toThrow();
});
it("translates every title but no unread body; active members use the existing display-language resolution", async () => {
  const db = await setup();
  await addMember(db, "reader", "scope_reader", { readLangs: ["fr"] });
  await db.update(profiles).set({ uiLocale: "en" }).where(eq(profiles.userId, "reader"));
  await addMember(db, "stopped", "scope_stopped");
  await db.update(profiles).set({ displayLang: "de", suspendedUntil: new Date(Date.now() + 86400000) }).where(eq(profiles.userId, "stopped"));
  const source = await topic(db);
  expect((await queued(db, TITLE_TRANSLATE_JOB))).toHaveLength(8);
  expect((await queued(db, TRANSLATE_JOB)).map(row => (row.payload as { lang: string }).lang)).toEqual(["en"]);
  await enqueueTranslations(db, { id: source.id, lang: source.lang, sourceHash: source.sourceHash! });
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(1);
});
it("adds village members and followers below the threshold, including for replies", async () => {
  const db = await setup();
  vi.stubEnv("TRANSLATION_EAGER_MIN_READERS", "50");
  for (const [id, lang] of [["member", "fr"], ["follower", "de"]]) {
    await addMember(db, id, `scope_${id}`);
    await db.update(profiles).set({ displayLang: lang }).where(eq(profiles.userId, id));
  }
  await db.insert(villages).values({ id: "abcdef0123456789abcdef0123456789", slug: "abcdef0123456789abcdef0123456789", name: "Audience", kind: "open", sourceLang: "en" });
  await db.insert(villageMembers).values({ villageId: "abcdef0123456789abcdef0123456789", userId: "member" });
  await db.insert(villageFollows).values({ villageId: "abcdef0123456789abcdef0123456789", userId: "follower" });
  const source = await topic(db);
  await db.update(entries).set({ villageId: "abcdef0123456789abcdef0123456789" }).where(eq(entries.id, source.id));
  expect(await eagerBodyLangs(db, source.id)).toEqual(["fr", "de"]);
  const reply = await createReply(db, "source", source.id, { lang: "ja", body: "返信。" });
  if (!reply.ok) throw new Error(reply.error);
  expect((await eagerBodyLangs(db, reply.id))).toEqual(["fr", "de"]);
});
it("keeps recipient languages for notification excerpts and daily mail when N is raised", async () => {
  const db = await setup(); vi.stubEnv("TRANSLATION_EAGER_MIN_READERS", "50");
  await addMember(db, "reader", "scope_recipient");
  await db.update(profiles).set({ displayLang: "fr", emailPref: "daily" }).where(eq(profiles.userId, "reader"));
  const source = await topic(db);
  const result = await createReply(db, "reader", source.id, { lang: "en", body: "Reply" });
  if (!result.ok) throw new Error(result.error);
  const edited = await editEntry(db, "source", source.id, { title: "原題", body: "@scope_recipient 新しい本文。" });
  expect(edited.ok).toBe(true);
  expect((await queued(db, TRANSLATE_JOB)).some(job => (job.payload as { entryId: number; lang: string }).entryId === source.id && (job.payload as { lang: string }).lang === "fr")).toBe(true);
});
it("all queues every body, while edits under readers defer other languages and preserve their rows", async () => {
  const db = await setup(); vi.stubEnv("TRANSLATION_EAGER_SCOPE", "all");
  const source = await topic(db);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(8);
  await db.insert(translations).values({ entryId: source.id, field: "body", lang: "fr", kind: "primary", text: "Old", sourceHash: source.sourceHash });
  await db.delete(jobs);
  vi.stubEnv("TRANSLATION_EAGER_SCOPE", "readers");
  expect((await editEntry(db, "source", source.id, { title: "原題", body: "変更した本文。" })).ok).toBe(true);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(0);
  expect(await db.select().from(translations)).toHaveLength(1);
  const [current] = await db.select().from(entries).where(eq(entries.id, source.id));
  const input = { ...current, kind: "topic" as const, lang: "ja" as const };
  expect((await loadEntryDisplays(db, [input], { browser: new Set([source.id]), displayLang: "fr", readLangs: [] })).get(source.id)?.needsCurrent).toBe(true);
  await requestBodyTranslations(db, [input], "fr", true);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(1);
});
it("deduplicates browser work without rescheduling and promotes queued body priority", async () => {
  const db = await setup(); const source = await topic(db);
  await requestBodyTranslations(db, [source], "fr", true);
  const [first] = await queued(db, TRANSLATE_JOB);
  await db.update(jobs).set({ priority: 2, status: "running" }).where(eq(jobs.id, first.id));
  await requestBodyTranslations(db, [source], "fr", true);
  const [same] = await queued(db, TRANSLATE_JOB);
  expect(same.id).toBe(first.id); expect(same.runAt).toEqual(first.runAt);
  await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, first.id));
  await requestBodyTranslations(db, [source], "fr", true);
  expect((await queued(db, TRANSLATE_JOB))[0].priority).toBe(1);
});
it("keeps one request for a restored source revision while the older identical hash is running", async () => {
  const db = await setup(); const source = await topic(db);
  await requestBodyTranslations(db, [source], "fr", true);
  const [first] = await queued(db, TRANSLATE_JOB);
  await db.update(jobs).set({ status: "running", payload: { ...(first.payload as object), paidProof: "retained" } }).where(eq(jobs.id, first.id));
  expect((await editEntry(db, "source", source.id, { title: "原題", body: "別の本文。" })).ok).toBe(true);
  expect((await editEntry(db, "source", source.id, { title: "原題", body: source.body })).ok).toBe(true);
  const [row] = await db.select().from(entries).where(eq(entries.id, source.id));
  expect(row.sourceHash).toBe(source.sourceHash);
  const restored = { ...row, kind: "topic" as const, lang: "ja" as const };
  await requestBodyTranslations(db, [restored], "fr", true);
  const [rearmed] = await queued(db, TRANSLATE_JOB);
  expect(rearmed.id).toBe(first.id);
  expect((rearmed.payload as { paidProof: string }).paidProof).toBe("retained");
  expect(rearmed.runAt.getTime()).toBeGreaterThan(first.runAt.getTime());
  expect((rearmed.payload as { readRevision: number }).readRevision).toBe(row.mentionRevision);
  await requestBodyTranslations(db, [restored], "fr", true);
  expect((await queued(db, TRANSLATE_JOB))[0].runAt).toEqual(rearmed.runAt);
});
it("retains stale human translations without retrying a terminal failure on each browser visit", async () => {
  const db = await setup(); const source = await topic(db);
  await db.insert(translations).values({ entryId: source.id, field: "body", lang: "fr", kind: "human", text: "Ancienne traduction", sourceHash: "older", flags: ["stale"] });
  await requestBodyTranslations(db, [source], "fr", true);
  const [job] = await queued(db, TRANSLATE_JOB);
  await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));
  expect((await requestBodyTranslations(db, [source], "fr", true)).unavailable).toEqual([source.id]);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(1);
  const display = (await loadEntryDisplays(db, [source], { browser: new Set([source.id]), displayLang: "fr", readLangs: [] })).get(source.id)!;
  expect(display.translation?.stale).toBe(true); expect(display.needsCurrent).toBeUndefined();
});
it("status checks and exhausted budgets never queue work", async () => {
  const db = await setup(); const source = await topic(db);
  expect((await requestBodyTranslations(db, [source], "fr", false)).stopped).toBe(false);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(0);
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  expect((await requestBodyTranslations(db, [source], "fr", true)).stopped).toBe(true);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(0);
});
it("reuses translation-wait estimates while polling and checks the live budget before enqueueing", async () => {
  const db = await setup();
  const source = await topic(db);
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "1");
  const estimate = vi.spyOn(metering, "translationEstimate");
  expect((await requestBodyTranslations(db, [source], "fr", false)).stopped).toBe(false);
  const firstCalls = estimate.mock.calls.length;
  expect(firstCalls).toBeGreaterThan(0);
  expect((await requestBodyTranslations(db, [source], "fr", false)).stopped).toBe(false);
  expect(estimate).toHaveBeenCalledTimes(firstCalls);

  // A remembered normal display state must not admit work after the ledger fills.
  await db.insert(llmUsage).values({ engine: "fake", model: "fake", purpose: "translate", costUsdMicro: 1_000_000 });
  expect((await requestBodyTranslations(db, [source], "fr", true)).stopped).toBe(true);
  expect(await queued(db, TRANSLATE_JOB)).toHaveLength(0);
});
it("records a first browser display once in batches and reports aggregate counts and percentages", async () => {
  const db = await setup(); const source = await topic(db);
  const other = await topic(db, null);
  const rows = await db.insert(translations).values([source, other].map(entry => ({ entryId: entry.id, field: "body", lang: "fr", kind: "primary", text: "Traduction", sourceHash: entry.sourceHash }))).returning();
  const first = new Date("2026-10-01T00:00:00Z");
  await loadEntryDisplays(db, [source], { readLangs: [], displayLang: "fr" });
  expect((await db.select().from(translations))[0].firstSeenAt).toBeNull();
  expect((await db.select().from(translations)).every(row => !row.everSeen)).toBe(true);
  expect(await markTranslationsSeen(db, [source], "fr", rows.map(r => r.id), null, first)).toBe(1);
  expect(await markTranslationsSeen(db, [source], "fr", [rows[0].id], null, new Date())).toBe(0);
  expect((await db.select().from(translations).where(eq(translations.id, rows[0].id)))[0].firstSeenAt).toEqual(first);
  expect((await db.select().from(translations).where(eq(translations.id, rows[0].id)))[0].everSeen).toBe(true);
  expect((await db.select().from(translations).where(eq(translations.id, rows[1].id)))[0].everSeen).toBe(false);
  const stats = await translationReadStats(db);
  expect(stats).toEqual(expect.arrayContaining([{ sourceLang: "ja", targetLang: "fr", kind: "topic", total: 1, seen: 1, percent: 100 }, { sourceLang: "ja", targetLang: "fr", kind: "short_post", total: 1, seen: 0, percent: 0 }]));
  expect(JSON.stringify(stats)).not.toMatch(/source_writer|userId|member/);
});
it("checks each post's writer separately when a display batch includes replies", async () => {
  const db = await setup(); const source = await topic(db);
  await addMember(db, "reply_writer", "reply_writer");
  const result = await createReply(db, "reply_writer", source.id, { lang: "ja", body: "別の書き手の返信。" });
  if (!result.ok) throw new Error(result.error);
  const [reply] = await db.select().from(entries).where(eq(entries.id, result.id));
  const rows = await db.insert(translations).values([source, reply].map(entry => ({ entryId: entry.id, field: "body", lang: "fr", kind: "primary", text: "Traduction", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision }))).returning();
  expect(await markTranslationsSeen(db, [source, { ...reply, kind: "reply", lang: "ja" }], "fr", rows.map(row => row.id), "source")).toBe(2);
  const marked = await db.select().from(translations).orderBy(translations.id);
  expect(marked.every(row => row.firstSeenAt !== null)).toBe(true);
  expect(marked.map(row => row.everSeen)).toEqual([false, true]);
});
it("atomically counts requested pairs rather than HTTP calls", async () => {
  const db = await createTestDb();
  const key = "translation-read:test";
  expect((await hitRateLimit(db, { key, limit: 120, windowSeconds: 3600, cost: 101 })).remaining).toBe(19);
  expect((await hitRateLimit(db, { key, limit: 120, windowSeconds: 3600, cost: 20 })).allowed).toBe(false);
});

describe("browser-only route", () => {
  let h: RouteHarness;
  afterEach(() => h?.restore());
  async function seed() {
    h = await setupRouteHarness(); await h.signIn("hana"); await h.signIn("halfway", { profile: false }); vi.stubEnv("TRANSLATION_EAGER_SCOPE", "readers");
    const result = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "原題", body: "本文。" });
    if (!result.ok) throw new Error(result.error);
    await h.db.delete(jobs);
    return result.id;
  }
  function post(id: number, opts: { as?: string; ids?: number[]; headers?: Record<string, string>; intent?: string } = {}) {
    const path = `/t/${id}/translations?lang=fr`;
    const base = h.request(path, { as: opts.as });
    const headers = new Headers(base.headers);
    Object.entries({ origin: "http://localhost:5173", referer: `http://localhost:5173/t/${id}?lang=fr`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...opts.headers }).forEach(([key, value]) => headers.set(key, value));
    return action(h.args(new Request(base.url, { method: "POST", headers, body: JSON.stringify({ intent: opts.intent ?? "request", ids: opts.ids ?? [id] }) }), { id: String(id) }));
  }
  it.each(["hana", undefined])("serves the same reservation wait to member and anonymous readers (viewer=%s)", async as => {
    const id = await seed();
    vi.stubEnv("PUBLIC_READING", "1");
    const [source] = await h.db.select().from(entries).where(eq(entries.id, id));
    const payload = { entryId: id, lang: "fr" as const, sourceHash: source.sourceHash! };
    await h.db.insert(jobs).values({ kind: TRANSLATE_JOB, payload, dedupeKey: translateDedupeKey(payload, "ja"),
      lastError: `deferred: [${BUDGET_RESERVATION_WAIT}] waiting`, runAt: new Date(Date.now() + 900_000) });
    const page = await import("~/routes/topic");
    const loaded = await page.loader(h.args(h.request(`/t/${id}?lang=fr`, { as }), { id: String(id) }));
    if (loaded.topic.placeholder !== null) throw new Error("Expected a readable topic");
    expect(loaded.topic.display).toMatchObject({ wait: { kind: "stopped" }, needsCurrent: true });
    const response = await post(id, { as, intent: "status" });
    expect(response.data).toMatchObject({ paused: [id], ready: [], stopped: false });
  });
  it("retains hidden and deleted reply slots in ordinary pages and removes them before paging by stance", async () => {
    const id = await seed();
    const stamp = new Date();
    const replies = await h.db.insert(entries).values(Array.from({ length: 103 }, (_, index) => ({
      kind: "reply", threadId: id, authorId: h.ids.hana, lang: "ja", body: "Page boundary fixture", sourceHash: "fixture",
      createdAt: stamp, deletedAt: index === 0 ? stamp : null, hiddenAt: index === 1 ? stamp : null,
      stanceTag: index < 4 || index === 102 ? "agree" : null,
    }))).returning({ id: entries.id });
    const ids = replies.map(row => row.id);
    expect((await translationPageInputs(h.db, id))?.map(row => row.id)).toEqual([id, ...ids.slice(2, 100)]);
    expect((await translationPageInputs(h.db, id, { page: 2 }))?.map(row => row.id)).toEqual([id, ...ids.slice(100)]);
    expect(await translationPageInputs(h.db, id, { page: 3 })).toBeNull();
    expect((await translationPageInputs(h.db, id, { stanceTag: "agree" }))?.map(row => row.id)).toEqual([id, ids[2], ids[3], ids[102]]);
    expect(await translationPageInputs(h.db, id, { page: 2, stanceTag: "agree" })).toBeNull();
  });
  it.each(["request", "status", "seen"])("keeps %s free of source rendering and rejects unreadable topics", async intent => {
    const id = await seed();
    await h.db.update(entries).set({ html: null, htmlVersion: 0 }).where(eq(entries.id, id));
    expect(await h.outcome(() => post(id, { as: "hana", intent }))).toMatchObject({ status: 200 });
    expect((await h.db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ html: null, htmlVersion: 0 });
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
    expect(await h.outcome(() => post(id, { as: "hana", intent }))).toMatchObject({ status: 404 });
  });
  it.each(["member", "moderator", "operator", "anonymous"])("keeps an author's first display out of lifetime reach until a later %s reads the same version", async role => {
    const id = await seed();
    await h.signIn("reach_reader");
    if (role === "anonymous") vi.stubEnv("PUBLIC_READING", "1");
    if (role === "operator") vi.stubEnv("OPERATOR_EMAILS", "reach_reader@example.com");
    if (role === "moderator") await h.db.insert(roles).values({ userId: h.ids.reach_reader, role: "moderator", lang: "fr" });
    const [source] = await h.db.select().from(entries).where(eq(entries.id, id));
    const [translation] = await h.db.insert(translations).values({ entryId: id, field: "body", lang: "fr", kind: "primary", text: "Traduction", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision }).returning();
    const report = (as?: string) => post(id, { as, ids: [translation.id], intent: "seen" });
    expect(await h.outcome(() => report("hana"))).toMatchObject({ status: 200 });
    const [first] = await h.db.select().from(translations).where(eq(translations.id, translation.id));
    expect(first.firstSeenAt).not.toBeNull();
    expect(first.everSeen).toBe(false);
    const display = (await loadEntryDisplays(h.db, [{ ...source, kind: "topic", lang: "ja" }], { readLangs: [], displayLang: "fr", browser: new Set([id]) })).get(id)!;
    expect(display.translation?.unseenIds).toContain(translation.id);
    expect(await h.outcome(() => report(role === "anonymous" ? undefined : "reach_reader"))).toMatchObject({ status: 200 });
    expect((await h.db.select().from(translations).where(eq(translations.id, translation.id)))[0]).toMatchObject({ firstSeenAt: first.firstSeenAt, everSeen: true });
    expect(await h.outcome(() => report("hana"))).toMatchObject({ status: 200 });
    expect((await h.db.select().from(translations).where(eq(translations.id, translation.id)))[0]).toMatchObject({ firstSeenAt: first.firstSeenAt, everSeen: true });
  });
  it("keeps unrequested author-menu languages selectable and eligible for browser work", async () => {
    const id = await seed();
    const page = await import("~/routes/topic");
    const loaded = await page.loader(h.args(h.request(`/t/${id}?lang=fr`, { as: "hana" }), { id: String(id) }));
    expect(loaded.translating).toEqual([]);
    expect(loaded.topic).toMatchObject({ display: { needsCurrent: true } });
    await post(id, { as: "hana" });
    expect(await queued(h.db, TRANSLATE_JOB)).toHaveLength(1);
  });
  it.each(["status", "seen"])("bounds member %s calls before reading the thread, with an opaque shared key", async intent => {
    const id = await seed();
    const key = translationReadLimitKey(h.ids.hana, "calls");
    expect(key).not.toContain(h.ids.hana);
    expect(key).not.toBe(translationReadLimitKey(h.ids.hana, "pairs"));
    expect(key).not.toBe(translationReadLimitKey(h.ids.hana, "calls", "another-test-secret"));
    await hitRateLimit(h.db, { key, limit: TRANSLATION_READ_CALLS_HOURLY, windowSeconds: 3600, cost: TRANSLATION_READ_CALLS_HOURLY - 1 });
    expect(await h.outcome(() => post(id, { as: "hana", intent }))).toMatchObject({ status: 200 });
    // Even a nonexistent topic is rejected before the expensive page lookup.
    expect(await h.outcome(() => post(id + 999999, { as: "hana", intent }))).toMatchObject({ status: 429 });
    expect(await h.outcome(() => post(id, { as: "hana", intent: intent === "seen" ? "status" : "seen" }))).toMatchObject({ status: 429 });
    expect((await h.db.select().from(rateLimits)).some(row => row.key.includes(h.ids.hana))).toBe(false);
    expect(await queued(h.db, TRANSLATE_JOB)).toHaveLength(0);
  });
  it("shares the anonymous call cap across status and display reports", async () => {
    const id = await seed(); vi.stubEnv("PUBLIC_READING", "1");
    await hitRateLimit(h.db, { key: "translation-read-calls:unknown", limit: TRANSLATION_READ_CALLS_HOURLY, windowSeconds: 3600, cost: TRANSLATION_READ_CALLS_HOURLY - 1 });
    expect(await h.outcome(() => post(id, { intent: "status" }))).toMatchObject({ status: 200 });
    expect(await h.outcome(() => post(id, { intent: "seen" }))).toMatchObject({ status: 429 });
  });
  it("keeps anonymous translation POSTs out of the ordinary public-read budget, including at its limit", async () => {
    const id = await seed(); vi.stubEnv("PUBLIC_READING", "1");
    const { getReader } = await import("~/lib/auth/session.server");
    const { hitPublicReadLimit } = await import("~/lib/rate-limit.server");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const headers = { "x-forwarded-for": "192.0.2.81" };
    const read = () => h.request(`/t/${id}`, { headers });
    for (let n = 0; n < 599; n++) await hitPublicReadLimit(h.db, read());
    for (const intent of ["request", "status", "seen"] as const) expect(await h.outcome(() => post(id, { intent, headers }))).toMatchObject({ status: 200 });
    expect(await h.outcome(() => getReader(read()))).toMatchObject({ status: 200 });
    expect(await h.outcome(() => post(id, { intent: "status", headers }))).toMatchObject({ status: 200 });
    // Other anonymous POSTs retain their public-read accounting.
    expect(await h.outcome(() => getReader(h.request(`/t/${id}`, { form: { intent: "other" }, headers })))).toMatchObject({ status: 429 });
  });
  it("does not enroll a hidden reply shown only to its author in the browser batch", async () => {
    const id = await seed();
    const reply = await createReply(h.db, h.ids.hana, id, { lang: "ja", body: "非表示の返信。" });
    if (!reply.ok) throw new Error(reply.error);
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply.id));
    const page = await import("~/routes/topic");
    const result = await page.loader(h.args(h.request(`/t/${id}?lang=fr`, { as: "hana" }), { id: String(id) }));
    expect(result.replies.find(r => r.id === reply.id)).toMatchObject({ hidden: true, display: { pending: true } });
    const hidden = result.replies.find(r => r.id === reply.id)!;
    expect(hidden.placeholder === null && hidden.display.needsCurrent).toBeUndefined();
  });
  it("server-rendered HTML and all-language Markdown never enqueue or mark translations", async () => {
    const id = await seed();
    const page = await import("~/routes/topic");
    const { buildThreadMarkdown } = await import("~/lib/md/thread.server");
    expect(await h.outcome(() => page.loader(h.args(h.request(`/t/${id}?lang=fr`, { as: "hana" }), { id: String(id) })))).toMatchObject({ status: 200 });
    expect(await buildThreadMarkdown(h.db, id, { page: 1, lang: "all", sentences: false, k: null, readerId: h.ids.hana })).not.toBeNull();
    expect(await queued(h.db, TRANSLATE_JOB)).toHaveLength(0);
  });
  it("rejects GET and non-browser/cross-origin/bot requests without queueing", async () => {
    const id = await seed();
    expect(await h.outcome(() => loader())).toMatchObject({ status: 405 });
    for (const headers of [{ origin: "https://elsewhere.invalid" }, { "sec-fetch-site": "" }, { "sec-fetch-dest": "document" }, { "user-agent": "GPTBot" }, { referer: "http://localhost:5173/home" }] as Record<string, string>[]) {
      expect(await h.outcome(() => post(id, { as: "hana", headers }))).toMatchObject({ status: 403 });
    }
    expect(await queued(h.db, TRANSLATE_JOB)).toHaveLength(0);
  });
  it("fixes logged-out behavior in private and public reading modes and rejects posts outside the page", async () => {
    const id = await seed();
    expect(await h.outcome(() => post(id))).toMatchObject({ status: 302, location: "/login" });
    vi.stubEnv("PUBLIC_READING", "1");
    expect(await h.outcome(() => post(id))).toMatchObject({ status: 200 });
    expect(await queued(h.db, TRANSLATE_JOB)).toHaveLength(1);
    expect(await h.outcome(() => post(id, { ids: [id + 999999] }))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => post(id, { ids: Array.from({ length: 102 }, (_, n) => n + 1) }))).toMatchObject({ status: 400 });
    expect(await h.outcome(() => post(id, { as: "halfway" }))).toMatchObject({ status: 302, location: "/onboarding" });
  });
  it("enforces the anonymous pair cap and never queues hidden content", async () => {
    const id = await seed(); vi.stubEnv("PUBLIC_READING", "1");
    for (let n = 0; n < 120; n++) await post(id);
    expect(await h.outcome(() => post(id))).toMatchObject({ status: 429 });
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
    expect(await h.outcome(() => post(id, { as: "hana" }))).toMatchObject({ status: 404 });
  });
});
