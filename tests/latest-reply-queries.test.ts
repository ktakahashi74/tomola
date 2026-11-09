import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { entries, translations } from "~/lib/db/schema";
import { createReply, createTopic, listTopics } from "~/lib/entries.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { addMember, createTestDb } from "./helpers/db";

it.each(["en", "ja"] as const)("batches %s reply locations for thirty rows as for one", async (lang) => {
  const db = await createTestDb();
  await addMember(db, "writer", "writer", { readLangs: ["en"] });
  for (let i = 0; i < 30; i++) {
    const topic = await createTopic(db, "writer", { lang: "en", body: `Topic ${i}` });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "writer", topic.id, { lang, body: lang === "en" ? `Reply ${i}` : `日本語の返信 ${i}` });
    if (!reply.ok) throw new Error("reply failed");
    if (lang === "ja") {
      const [source] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, reply.id));
      await db.insert(translations).values({ entryId: reply.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, text: `Reply ${i}` });
    }
  }
  const { topics } = await listTopics(db, { kind: "all" }, { limit: 30 });
  const client = (db as unknown as { $client: { query: (...args: unknown[]) => unknown } }).$client;
  const measure = async (size: number) => {
    const spy = vi.spyOn(client, "query");
    try {
      const cards = await toTopicItems(db, topics.slice(0, size), { readLangs: ["en"], displayLang: "en" });
      expect(cards).toHaveLength(size);
      expect(cards.every(card => card.latestReply?.page === 1)).toBe(true);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };
  const one = await measure(1);
  const twenty = await measure(30);
  await db.update(entries).set({ html: null, htmlVersion: 0 }).where(eq(entries.kind, "reply"));
  const uncachedOne = await measure(1);
  const uncachedTwenty = await measure(30);
  console.info(JSON.stringify({ rowQueries: { lang, one, twenty, uncachedOne, uncachedTwenty } }));
  expect(twenty).toBe(one);
  expect(uncachedOne).toBe(one);
  expect(uncachedTwenty).toBe(twenty);
});
