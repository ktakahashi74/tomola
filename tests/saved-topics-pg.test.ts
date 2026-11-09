import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, savedTopics, user } from "~/lib/db/schema";
import { setTopicSaved } from "~/lib/saved-topics.server";
import { migrateDatabase } from "~/lib/db/migrate.server";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("saved topics on independent PostgreSQL connections", { tags: ["postgres"] }, () => {
  it("makes simultaneous saves one immutable row and cascades physical deletion", async () => {
    const scratch = await createScratchDb();
    try {
      const a = await scratch.open();
      const b = await scratch.open();
      await addMember(a, "saved_pg_reader", "saved_pg_reader");
      await addMember(a, "saved_pg_author", "saved_pg_author");
      const [topic] = await a.insert(entries).values({ kind: "topic", authorId: "saved_pg_author", lang: "en", body: "A remark" }).returning();
      const first = new Date("2026-10-01T00:00:00Z");
      expect(await Promise.all([setTopicSaved(a, "saved_pg_reader", topic.id, true, { now: first }), setTopicSaved(b, "saved_pg_reader", topic.id, true, { now: first })])).toEqual([{ ok: true, saved: true }, { ok: true, saved: true }]);
      await setTopicSaved(b, "saved_pg_reader", topic.id, true, { now: new Date() });
      expect(await a.select().from(savedTopics)).toEqual([{ userId: "saved_pg_reader", topicId: topic.id, createdAt: first }]);
      await a.delete(entries).where(eq(entries.id, topic.id));
      expect(await b.select().from(savedTopics)).toEqual([]);
      const [other] = await a.insert(entries).values({ kind: "topic", authorId: "saved_pg_author", lang: "en", body: "Another remark" }).returning();
      await setTopicSaved(a, "saved_pg_reader", other.id, true);
      await b.delete(user).where(eq(user.id, "saved_pg_reader"));
      expect(await a.select().from(savedTopics)).toEqual([]);
      await migrateDatabase({ kind: "pg", url: scratch.url });
    } finally { await scratch.drop(); }
  });
});
