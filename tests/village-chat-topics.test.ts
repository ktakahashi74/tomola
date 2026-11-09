import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { entries, jobs, translations, villages } from "~/lib/db/schema";
import { chatParts, type ActiveChatMessage } from "~/lib/village-chat";
import { addChatTopicCards, CHAT_TOPIC_BODY_CHARS, CHAT_TOPIC_CARD_LIMIT, CHAT_TOPIC_HEADLINE_LIMIT, CHAT_TOPIC_PAGE_LIMIT } from "~/lib/village-chat-topics.server";
import { sourceHash } from "~/lib/source-hash.server";
import * as markdown from "~/lib/markdown-budget.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("BETTER_AUTH_URL", "https://tomola.example");
  const db = await createTestDb(); await addMember(db, "topiccard", "topiccard", { homeArea: "ja" });
  const insert = async (input: Partial<typeof entries.$inferInsert> = {}) => {
    const title = input.title === undefined ? "公開の題" : input.title, body = input.body ?? "公開の本文";
    const [row] = await db.insert(entries).values({ authorId: "topiccard", kind: "topic", lang: "ja", title, body, sourceHash: sourceHash(title, body), ...input }).returning();
    return row;
  };
  return { db, insert };
}
function message(body: string, id = "message"): ActiveChatMessage {
  return { id, author: "topiccard", own: true, lang: "en", parts: chatParts(body), createdSeq: 1, changedSeq: 1, createdAt: new Date().toISOString(), edited: false, deleted: false, hidden: false, translation: null };
}
function capture(db: Awaited<ReturnType<typeof createTestDb>>, details?: Array<{ params: unknown[]; rows: unknown[] }>) {
  const client = (db as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
  const run = client.query.bind(client), seen: string[] = [];
  vi.spyOn(client, "query").mockImplementation(async (...a) => {
    const q = a[0]; seen.push(typeof q === "string" ? q : q && typeof q === "object" && "text" in q ? String(q.text) : "");
    const result = await run(...a) as { rows: unknown[] };
    const params = Array.isArray(a[1]) ? a[1] : q && typeof q === "object" && "values" in q ? q.values as unknown[] : [];
    details?.push({ params, rows: result.rows }); return result;
  });
  return seen;
}
it("expands only same-origin public topics, deduplicates fragments and caps candidates before querying", async () => {
  const w = await world();
  const visible = await Promise.all(Array.from({ length: CHAT_TOPIC_CARD_LIMIT + 1 }, () => w.insert()));
  const deleted = await w.insert({ deletedAt: new Date() }), hidden = await w.insert({ hiddenAt: new Date() }), reply = await w.insert({ kind: "reply", title: null, threadId: visible[0].id });
  const [privateVillage] = await w.db.insert(villages).values({ kind: "closed", slug: "private-card", name: "Private card" }).returning();
  const privateTopic = await w.insert({ villageId: privateVillage.id });
  const links = `https://elsewhere.example/t/${visible[0].id} https://tomola.example/t/${visible[0].id}#c-42 https://tomola.example/t/${visible[0].id}?page=2#reply ${visible.slice(1).map(t => `https://tomola.example/t/${t.id}`).join(" ")}`;
  const [result] = await addChatTopicCards(w.db, [message(links)], { displayLang: "en", readLangs: [] });
  expect(result.topics?.map(card => card.id)).toEqual(visible.slice(0, CHAT_TOPIC_CARD_LIMIT).map(t => t.id));
  expect(result.topics?.every(card => card.replyHref.endsWith("#reply"))).toBe(true);
  expect(result.parts).toEqual(chatParts(links));
  for (const topic of [deleted, hidden, reply, privateTopic]) {
    expect((await addChatTopicCards(w.db, [message(`https://tomola.example/t/${topic.id}`)]))[0].topics).toBeUndefined();
  }
  const unavailableFirst = message(`https://tomola.example/t/${deleted.id} https://tomola.example/t/${hidden.id} https://tomola.example/t/999999 https://tomola.example/t/${visible[0].id}`);
  expect((await addChatTopicCards(w.db, [unavailableFirst]))[0].topics).toBeUndefined();
});
it("bounds candidate IDs for link-heavy messages and the whole page before its one query", async () => {
  const w = await world();
  const topics = await w.db.insert(entries).values(Array.from({ length: CHAT_TOPIC_PAGE_LIMIT + 3 }, (_, i) => ({ authorId: "topiccard", kind: "topic" as const, lang: "en", title: `Bounded card ${i}`, body: "Public body" }))).returning();
  const details: Array<{ params: unknown[]; rows: unknown[] }> = [];
  const seen = capture(w.db, details);
  const links = (rows: typeof topics) => rows.map(t => `https://tomola.example/t/${t.id}`).join(" ");
  const [heavy] = await addChatTopicCards(w.db, [message(links(topics.slice(0, 40)))]);
  expect(heavy.topics?.map(t => t.id)).toEqual(topics.slice(0, 3).map(t => t.id));
  expect(details[0].params.filter(p => typeof p === "number" && p !== CHAT_TOPIC_BODY_CHARS)).toEqual(topics.slice(0, 3).map(t => t.id));
  seen.length = 0; details.length = 0;
  const result = await addChatTopicCards(w.db, topics.map(t => message(links([t]), `m-${t.id}`)).concat(message(links([topics[0]]), "reused")));
  expect(seen).toHaveLength(1);
  expect(details[0].params.filter(p => typeof p === "number" && p !== CHAT_TOPIC_BODY_CHARS)).toEqual(topics.slice(0, CHAT_TOPIC_PAGE_LIMIT).map(t => t.id));
  expect(result.slice(CHAT_TOPIC_PAGE_LIMIT, -1).every(m => !m.topics)).toBe(true);
  expect(result.at(-1)?.topics?.[0].id).toBe(topics[0].id);
});
it("reads body prefixes and bounds headline workers, falling back within a POST write scope", async () => {
  const w = await world();
  const source = "Source prefix " + "s".repeat(CHAT_TOPIC_BODY_CHARS * 2), translated = "Translated prefix " + "x".repeat(CHAT_TOPIC_BODY_CHARS * 2);
  const topics = await w.db.insert(entries).values(Array.from({ length: CHAT_TOPIC_HEADLINE_LIMIT + 3 }, () => ({ authorId: "topiccard", kind: "topic" as const, lang: "ja", title: null, body: source, sourceHash: sourceHash(null, source) }))).returning();
  await w.db.insert(translations).values(topics.map(t => ({ entryId: t.id, lang: "en", field: "body", kind: "primary" as const, text: translated, sourceHash: t.sourceHash, flags: [] })));
  const details: Array<{ params: unknown[]; rows: unknown[] }> = [];
  const seen = capture(w.db, details);
  const worker = vi.spyOn(markdown, "markdownTask").mockImplementation(async (operation, args) => {
    expect(operation).toBe("headlineFromBody"); expect(markdown.isMarkdownWrite()).toBe(false);
    expect(args[0]).toBe(translated.slice(0, CHAT_TOPIC_BODY_CHARS));
    throw new markdown.MarkdownBusyError();
  });
  const messages = topics.map(t => message(`https://tomola.example/t/${t.id}`, `m-${t.id}`));
  const result = await markdown.withMarkdownScope("write", "topiccard", async () => {
    const cards = await addChatTopicCards(w.db, messages, { displayLang: "en", readLangs: [] });
    expect(markdown.isMarkdownWrite()).toBe(true); return cards;
  });
  expect(worker).toHaveBeenCalledTimes(1);
  expect(seen).toHaveLength(1); expect(seen[0]).toMatch(/left\("entries"\."body"/); expect(seen[0]).toMatch(/left\("translations"\."text"/);
  for (const raw of details[0].rows) {
    const values = Array.isArray(raw) ? raw : Object.values(raw as object);
    expect(values).toContain(source.slice(0, CHAT_TOPIC_BODY_CHARS)); expect(values).toContain(translated.slice(0, CHAT_TOPIC_BODY_CHARS));
    expect(values).not.toContain(source); expect(values).not.toContain(translated);
  }
  expect(result.slice(0, CHAT_TOPIC_HEADLINE_LIMIT).every(m => m.topics?.[0].title.startsWith("Translated prefix") && m.topics[0].lang === "en" && m.topics[0].fromBody)).toBe(true);
  expect(result.slice(CHAT_TOPIC_HEADLINE_LIMIT).every(m => !m.topics)).toBe(true);
  worker.mockImplementation(async () => { throw new markdown.MarkdownBudgetError(); });
  expect((await markdown.withMarkdownScope("write", "topiccard", () => addChatTopicCards(w.db, messages.slice(0, 1), { displayLang: "ja", readLangs: [] })))[0].topics?.[0].title).toMatch(/^Source prefix/);
});

it("omits over-budget titleless cards while retaining their original links and titled cards", async () => {
  const w = await world();
  const topics = await w.db.insert(entries).values(Array.from({ length: CHAT_TOPIC_HEADLINE_LIMIT + 1 }, (_, i) => ({ authorId: "topiccard", kind: "topic" as const, lang: "en", title: null, body: `# **Clean heading ${i}**` }))).returning();
  const titled = await w.insert({ lang: "en", title: "Explicit title" });
  const input = [...topics, titled].map(t => message(`https://tomola.example/t/${t.id}`, `m-${t.id}`));
  const result = await addChatTopicCards(w.db, input, { displayLang: "en", readLangs: ["en"] });
  expect(result.slice(0, CHAT_TOPIC_HEADLINE_LIMIT).every(m => m.topics?.[0].title.startsWith("Clean heading") && !m.topics[0].title.includes("**"))).toBe(true);
  expect(result[CHAT_TOPIC_HEADLINE_LIMIT].topics).toBeUndefined();
  expect(result[CHAT_TOPIC_HEADLINE_LIMIT].parts).toEqual(input[CHAT_TOPIC_HEADLINE_LIMIT].parts);
  expect(result.at(-1)?.topics?.[0].title).toBe("Explicit title");
});
it("uses saved translations, source fallback, readable-language preferences and titleless headlines", async () => {
  const w = await world();
  const named = await w.insert({ replyCount: 7 }), bare = await w.insert({ title: null, body: "**Bare public headline**\n\nAnother paragraph", lang: "en" });
  await w.db.insert(translations).values({ entryId: named.id, lang: "en", field: "title", kind: "primary", sourceHash: named.sourceHash, text: "A translated public title", engine: "fake", flags: [] });
  const text = `https://tomola.example/t/${named.id} https://tomola.example/t/${bare.id}`;
  const [english] = await addChatTopicCards(w.db, [message(text)], { displayLang: "en", readLangs: [], langParam: "en" });
  expect(english.topics).toMatchObject([{ title: "A translated public title", lang: "en", replyCount: 7, replyHref: `/t/${named.id}?lang=en#reply` }, { title: "Bare public headline", fromBody: true }]);
  const [original] = await addChatTopicCards(w.db, [message(text)], { displayLang: "en", readLangs: ["ja"] });
  expect(original.topics?.[0]).toMatchObject({ title: named.title, lang: "ja" });
  const [fallback] = await addChatTopicCards(w.db, [message(text)], { displayLang: "fr", readLangs: [] });
  expect(fallback.topics?.[0].title).toBe(named.title);
});
it("does not use stale or excluded machine titles and follows the existing human-title selection", async () => {
  const w = await world(), topic = await w.insert();
  const link = message(`https://tomola.example/t/${topic.id}`);
  await w.db.insert(translations).values({ entryId: topic.id, lang: "en", field: "title", kind: "primary", sourceHash: "0".repeat(64), text: "Obsolete machine title", flags: [] });
  expect((await addChatTopicCards(w.db, [link], { displayLang: "en", readLangs: [] }))[0].topics?.[0].title).toBe(topic.title);
  await w.db.update(translations).set({ sourceHash: topic.sourceHash, flags: ["untranslated"] }).where(eq(translations.entryId, topic.id));
  expect((await addChatTopicCards(w.db, [link], { displayLang: "en", readLangs: [] }))[0].topics?.[0].title).toBe(topic.title);
  await w.db.insert(translations).values({ entryId: topic.id, lang: "en", field: "title", kind: "human", sourceHash: topic.sourceHash, text: "Human public title", flags: [] });
  expect((await addChatTopicCards(w.db, [link], { displayLang: "en", readLangs: [] }))[0].topics?.[0].title).toBe("Human public title");
});
it("makes one query for the entire page, performs no writes or fetches, and never expands hidden messages", async () => {
  const w = await world(), topic = await w.insert();
  const before = await w.db.select().from(jobs);
  const seen = capture(w.db), fetch = vi.spyOn(globalThis, "fetch");
  const messages = Array.from({ length: 50 }, (_, i) => message(`https://tomola.example/t/${topic.id}`, `m-${i}`));
  const result = await addChatTopicCards(w.db, messages, { displayLang: "en", readLangs: [] });
  expect(result.every(row => row.topics?.length === 1)).toBe(true);
  expect(seen.filter(q => /^select\b/i.test(q))).toHaveLength(1);
  expect(seen.filter(q => /^(?:insert|update|delete)\b/i.test(q))).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  const hidden = { ...message(`https://tomola.example/t/${topic.id}`), hidden: true };
  seen.length = 0;
  expect(await addChatTopicCards(w.db, [hidden])).toEqual([hidden]);
  expect(seen).toEqual([]);
  vi.restoreAllMocks(); expect(await w.db.select().from(jobs)).toEqual(before);
});
it("preserves disabled responses and does not reparse plain text or external links", async () => {
  const w = await world(), topic = await w.insert();
  const seen = capture(w.db);
  const plain = [message(`/t/${topic.id} https://elsewhere.example/t/${topic.id}`)];
  expect(await addChatTopicCards(w.db, plain)).toBe(plain);
  expect(seen).toEqual([]);
  const linked = [message(`https://tomola.example/t/${topic.id}`)];
  for (const [v, c] of [["1", ""], ["", "1"], ["", ""]]) {
    vi.stubEnv("VILLAGES", v); vi.stubEnv("VILLAGE_CHAT", c);
    expect(await addChatTopicCards(w.db, linked)).toBe(linked);
  }
  expect(seen).toEqual([]);
});
