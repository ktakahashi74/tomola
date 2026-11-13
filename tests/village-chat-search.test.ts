import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { seedRateLimit } from "./helpers/fixtures";
import { consentChatMembers } from "./helpers/chat-consent";
import { chatConsents, chatMessages, chatMessageTranslations, chatSequences, entries, jobs, llmUsage, profiles, rateLimits, villageMembers, villages } from "~/lib/db/schema";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { chatSourceHash } from "~/lib/village-chat-translations.server";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import * as search from "~/lib/village-chat-search.server";
import { action, headers, loader } from "~/routes/village-chat-search";
import { loader as chatPage } from "~/routes/village-chat";

let h: RouteHarness, counter = 0;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["cs_author", "cs_reader", "cs_outsider"]) await h.signIn(handle, { homeArea: "en", readLangs: ["en"] });
  await h.signIn("cs_incomplete", { profile: false });
}, 60_000);
afterAll(() => h.restore());
beforeEach(() => { vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function world() {
  const [village] = await h.db.insert(villages).values({ slug: `search-case-${++counter}`, kind: "open" }).returning();
  await h.db.insert(villageMembers).values(["cs_author", "cs_reader"].map(handle => ({ villageId: village.id, userId: h.ids[handle] })));
  await consentChatMembers(h.db);
  let seq = 0;
  return {
    village,
    async message(body: string, extra: Partial<typeof chatMessages.$inferInsert> = {}) {
      seq++;
      const [row] = await h.db.insert(chatMessages).values({ villageId: village.id, authorId: h.ids.cs_author, lang: "ja", body, createdSeq: seq, changedSeq: seq, ...extra }).returning();
      return row;
    },
    args(form?: Record<string, string>, as: string | null = "cs_reader", query = "") {
      return h.args(h.request(`/v/${village.slug}/chat/search${query}`, { as: as ?? undefined, ...(form ? { form } : {}) }), { slug: village.slug! });
    },
    async find(q: string, before?: number, query = "") {
      const result = await action(this.args({ q, ...(before === undefined ? {} : { before: String(before) }) }, "cs_reader", query));
      if (!("hits" in result.data)) throw new Error(`Search failed: ${result.data.error}`);
      return result.data;
    },
  };
}

it("finds literal Unicode substrings and punctuation without interpreting SQL or wildcard syntax", async () => {
  const w = await world();
  const body = "alpha beta 日本語の途中 中文字符 한국어 문장 50%_\\ ' OR 1=1 -- 😀";
  const message = await w.message(body);
  for (const query of ["途中", "文字", "한국", "50%_\\", "' OR 1=1 --", "😀", "ALPHA", " \t alpha \n beta "]) {
    const result = await w.find(query);
    expect(result.hits.map(hit => hit.id), query).toEqual([message.id]);
    expect(result.hits[0].matches[0].source).toBe("original");
  }
  expect((await w.find("50abcX")).hits).toEqual([]);
});

it("scopes results to visible chat messages in this village, excluding public posts", async () => {
  const w = await world(), other = await world();
  const visible = await w.message("scopeword visible");
  await w.message("scopeword hidden", { hiddenAt: new Date() });
  await w.message("", { deletedAt: new Date() });
  await other.message("scopeword elsewhere");
  await h.db.insert(entries).values({ kind: "topic", authorId: h.ids.cs_author, lang: "en", title: "scopeword", body: "scopeword public post", villageId: w.village.id });
  expect((await w.find("scopeword")).hits.map(hit => hit.id)).toEqual([visible.id]);
});

it("searches only ready translations of the current source in the display language and deduplicates both matches", async () => {
  const w = await world();
  const ready = await w.message("現在の原文"), stale = await w.message("直した原文"), both = await w.message("translationneedle 両方");
  const states = await Promise.all(["pending", "failed", "paused"].map(state => w.message(`原文 ${state}`)));
  const wrongLanguage = await w.message("別の言語"), noTranslation = await w.message("translationneedle 原文だけ");
  await h.db.insert(chatMessageTranslations).values([
    { messageId: ready.id, lang: "en", state: "ready", sourceHash: chatSourceHash(ready.body), text: "translationneedle current" },
    { messageId: stale.id, lang: "en", state: "ready", sourceHash: chatSourceHash("古い原文"), text: "translationneedle stale" },
    { messageId: both.id, lang: "en", state: "ready", sourceHash: chatSourceHash(both.body), text: "translationneedle both" },
    ...states.map((message, i) => ({ messageId: message.id, lang: "en", state: ["pending", "failed", "paused"][i] as "pending" | "failed" | "paused", sourceHash: chatSourceHash(message.body), text: "translationneedle unfinished" })),
    { messageId: wrongLanguage.id, lang: "fr", state: "ready", sourceHash: chatSourceHash(wrongLanguage.body), text: "translationneedle français" },
  ]);
  const beforeJobs = await h.db.select().from(jobs), beforeUsage = await h.db.select().from(llmUsage);
  const result = await w.find("translationneedle");
  expect(result.hits.map(hit => hit.id)).toEqual([noTranslation.id, both.id, ready.id]);
  expect(result.hits.find(hit => hit.id === both.id)!.matches.map(match => match.source)).toEqual(["original", "translation"]);
  expect(result.hits.find(hit => hit.id === ready.id)!.matches[0]).toMatchObject({ source: "translation", lang: "en" });
  expect((await w.find("translationneedle", undefined, "?lang=fr")).hits.map(hit => hit.id)).toEqual([noTranslation.id, wrongLanguage.id, both.id]);
  expect(await h.db.select().from(jobs)).toEqual(beforeJobs);
  expect(await h.db.select().from(llmUsage)).toEqual(beforeUsage);
});

it("pages by creation sequence without duplication or gaps during arrivals, deletion and hiding", async () => {
  const w = await world(); const messages = [];
  for (let i = 0; i < 45; i++) messages.push(await w.message(`pageword ${i}`));
  let result = await w.find("pageword");
  expect(result.hits).toHaveLength(search.CHAT_SEARCH_LIMIT);
  const found = result.hits.map(hit => hit.id);
  const arrival = await w.message("pageword arrived after the first page");
  await h.db.update(chatMessages).set({ deletedAt: new Date(), body: "" }).where(eq(chatMessages.id, messages[23].id));
  await h.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, messages[22].id));
  while (result.before !== null) {
    result = await w.find("pageword", result.before);
    expect(result.hits.length).toBeLessThanOrEqual(search.CHAT_SEARCH_LIMIT);
    found.push(...result.hits.map(hit => hit.id));
  }
  expect(found).toEqual(messages.filter((_, i) => i !== 22 && i !== 23).reverse().map(message => message.id));
  expect(new Set(found).size).toBe(found.length); expect(found).not.toContain(arrival.id);
});

it("requires current membership and consent on opening, searching and continuing, while suspension permits reading", async () => {
  const w = await world(); await w.message("permissionword");
  for (const [as, status] of [[undefined, 302], ["cs_incomplete", 302], ["cs_outsider", 404]] as const) {
    const args = w.args({ q: "permissionword" }, as ?? null);
    expect(await h.outcome(() => action(args))).toMatchObject({ status });
    expect(await h.outcome(() => loader(w.args(undefined, as ?? null)))).toMatchObject({ status });
  }
  const ownConsent = and(eq(chatConsents.villageId, w.village.id), eq(chatConsents.userId, h.ids.cs_reader));
  await h.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION - 1 }).where(ownConsent);
  expect(await h.outcome(() => loader(w.args()))).toMatchObject({ status: 404 });
  const deniedForms: Record<string, string>[] = [{ q: "permissionword" }, { q: "permissionword", before: "2" }];
  for (const form of deniedForms) expect(await h.outcome(() => action(w.args(form)))).toMatchObject({ status: 404 });
  await h.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION }).where(ownConsent);
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.cs_reader));
  try { expect((await w.find("permissionword")).hits).toHaveLength(1); }
  finally { await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids.cs_reader)); }
  await h.db.delete(villageMembers).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, h.ids.cs_reader)));
  expect(await h.outcome(() => action(w.args({ q: "permissionword", before: "2" })))).toMatchObject({ status: 404 });
  vi.stubEnv("VILLAGE_CHAT", "");
  expect(await h.outcome(() => loader(w.args()))).toMatchObject({ status: 404 });
});

it("opens an older matching message with a fresh access check and returns only unavailable state after it disappears", async () => {
  const w = await world(); const old = await w.message("oldword");
  for (let i = 0; i < 80; i++) await w.message(`Later message ${i}`, { lang: "en" });
  await w.message("最新版の未訳の発言", { lang: "ja" });
  await h.db.insert(chatSequences).values({ villageId: w.village.id, seq: 82 });
  const jump = () => chatPage(h.args(h.request(`/v/${w.village.slug}/chat?at=${old.id}&from=search`, { as: "cs_reader" }), { slug: w.village.slug! }));
  const page = await jump();
  expect(page).toHaveProperty("messages", expect.arrayContaining([expect.objectContaining({ id: old.id })]));
  const pendingBeforeRefusal = await h.db.select().from(jobs);
  await h.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, old.id));
  await expect(jump()).rejects.toMatchObject({ data: { error: "chat_message_unavailable" }, init: { status: 404 } });
  expect(await h.db.select().from(jobs)).toEqual(pendingBeforeRefusal);
  await h.db.update(chatMessages).set({ hiddenAt: null, deletedAt: new Date(), body: "" }).where(eq(chatMessages.id, old.id));
  await expect(jump()).rejects.toMatchObject({ data: { error: "chat_message_unavailable" }, init: { status: 404 } });
  await h.db.delete(chatConsents).where(and(eq(chatConsents.villageId, w.village.id), eq(chatConsents.userId, h.ids.cs_reader)));
  await expect(jump()).rejects.toMatchObject({ data: { error: "chat_message_unavailable" }, init: { status: 404 } });
  await h.db.delete(villageMembers).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, h.ids.cs_reader)));
  await expect(jump()).rejects.toMatchObject({ data: { error: "chat_message_unavailable" }, init: { status: 404 } });
});

it("rejects invalid input and cross-origin requests and keeps successful and rate-limited responses private", async () => {
  const w = await world(); await w.message("privateword");
  for (const form of [{ q: "" }, { q: "x".repeat(501) }, { q: "nul\0word" }, ...["0", "-1", "1.5", "9007199254740992"].map(before => ({ q: "privateword", before }))]) {
    expect(await h.outcome(() => action(w.args(form)))).toMatchObject({ status: 400 });
  }
  const crossOrigin = h.args(h.request(`/v/${w.village.slug}/chat/search`, { as: "cs_reader", form: { q: "privateword" }, headers: { origin: "https://elsewhere.example" } }), { slug: w.village.slug! });
  expect(await h.outcome(() => action(crossOrigin))).toMatchObject({ status: 403 });
  const result = await action(w.args({ q: "privateword" }));
  expect(new Headers(result.init?.headers).get("Cache-Control")).toBe("private, no-store");
  expect(new Headers(result.init?.headers).get("X-Robots-Tag")).toBe("noindex");
  await h.db.delete(rateLimits).where(eq(rateLimits.key, `member:chat-search:${h.ids.cs_reader}`));
  await seedRateLimit(h.db, `member:chat-search:${h.ids.cs_reader}`, MEMBER_RATE_LIMITS["chat-search"]);
  const limited = await action(w.args({ q: "privateword" }));
  expect(limited).toMatchObject({ data: { error: "limit" }, init: { status: 429 } });
  const responseHeaders = headers({ actionHeaders: new Headers(limited.init?.headers) } as never);
  expect(responseHeaders.get("Cache-Control")).toBe("private, no-store");
  expect(responseHeaders.get("Retry-After")).not.toBeNull();
  await h.db.delete(rateLimits).where(eq(rateLimits.key, `member:chat-search:${h.ids.cs_reader}`));
});

it("does not persist search text or propagate text-bearing database errors to logs or error collection", async () => {
  const w = await world(); const marker = "private-query-retention-marker";
  const before = await h.db.execute(sql`select (select count(*) from chat_messages)::int as messages,
    (select count(*) from chat_message_translations)::int as translations, (select count(*) from jobs)::int as jobs,
    (select count(*) from llm_usage)::int as usage`);
  expect((await w.find(marker)).hits).toEqual([]);
  const after = await h.db.execute(sql`select (select count(*) from chat_messages)::int as messages,
    (select count(*) from chat_message_translations)::int as translations, (select count(*) from jobs)::int as jobs,
    (select count(*) from llm_usage)::int as usage`);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  expect(JSON.stringify(await h.db.select().from(rateLimits))).not.toContain(marker);
  const warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
  vi.spyOn(search, "findChatMessages").mockRejectedValueOnce(new Error(`SQL failed with ${marker}`));
  const failure = await action(w.args({ q: marker }));
  expect(failure).toMatchObject({ data: { error: "unavailable" }, init: { status: 503 } });
  expect(JSON.stringify(failure)).not.toContain(marker);
  expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
