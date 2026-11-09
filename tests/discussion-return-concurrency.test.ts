import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { entries, jobs, notifications, profiles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { markFollowedThreadRead, setFollow } from "~/lib/follows.server";
import { notifyForNewEntry, notificationEmailDedupeKey } from "~/lib/notifications.server";
import { followedThreadHrefs } from "~/lib/reply-locations.server";
import { addMember } from "./helpers/db";
import { holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("first unread reply with reversed PostgreSQL commits", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  let sequence = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterEach(async () => { await scratch?.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); }, 60_000);

  it.each(["earlier timestamp", "same timestamp", "timestamp before ID"] as const)("uses display order: %s", async (order) => {
    const [db, other] = await Promise.all([scratch.open("unread-first"), scratch.open("unread-second")]);
    const n = ++sequence;
    const author = `unread_author_${n}`, reader = `unread_reader_${n}`;
    await addMember(db, author, author);
    await addMember(db, reader, reader);
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, reader));
    const topic = await createTopic(db, author, { lang: "en", title: "Concurrent replies", body: "Topic" });
    if (!topic.ok) throw new Error(topic.error);
    await setFollow(db, reader, topic.id, true);
    const base = new Date("2030-01-01T00:00:00Z");
    const firstTime = new Date(base.getTime() + (order === "timestamp before ID" ? 1_000 : 0));
    const secondTime = new Date(base.getTime() + (order === "earlier timestamp" ? 1_000 : 0));
    let inserted!: (entry: typeof entries.$inferSelect) => void;
    const allocation = new Promise<typeof entries.$inferSelect>(resolve => { inserted = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const held = holdTx(db, async tx => {
      const [entry] = await tx.insert(entries).values({ kind: "reply", threadId: topic.id, authorId: author, lang: "en", body: "Allocated first", createdAt: firstTime }).returning();
      inserted(entry);
      await gate;
      await notifyForNewEntry(tx, { entry: { ...entry, kind: "reply", threadId: topic.id }, topicAuthorId: author, mentioned: [], now: firstTime });
      return entry;
    });
    const allocatedFirst = await allocation;
    let allocatedSecond: typeof allocatedFirst;
    try {
      const second = holdTx(other, async tx => {
        const [entry] = await tx.insert(entries).values({ kind: "reply", threadId: topic.id, authorId: author, lang: "en", body: "Committed first", createdAt: secondTime }).returning();
        await notifyForNewEntry(tx, { entry: { ...entry, kind: "reply", threadId: topic.id }, topicAuthorId: author, mentioned: [], now: secondTime });
        return entry;
      });
      try {
        allocatedSecond = await second.ready;
        resume();
        await waitForLockWait(await scratch.admin(), "unread-first");
        await second.commit();
        await held.ready;
        await held.commit();
      } finally { await second.rollback(); }
    } finally { resume(); await held.rollback(); }
    const earliest = order === "timestamp before ID" ? allocatedSecond : allocatedFirst;
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, reader), eq(notifications.threadId, topic.id), isNull(notifications.readAt)));
    expect(notice).toMatchObject({ firstEntryId: earliest.id, entryId: allocatedFirst.id, mergedCount: 2 });
    expect((await followedThreadHrefs(db, [notice])).get(notice.id)).toBe(`/t/${topic.id}#c-${earliest.id}`);
    expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, notificationEmailDedupeKey(notice.id)))).toHaveLength(1);
    await markFollowedThreadRead(db, reader, topic.id, base);
    const [next] = await db.insert(entries).values({ kind: "reply", threadId: topic.id, authorId: author, lang: "en", body: "Next unread group" }).returning();
    await db.transaction(tx => notifyForNewEntry(tx, { entry: { ...next, kind: "reply", threadId: topic.id }, topicAuthorId: author, mentioned: [], now: base }));
    const unread = await db.select().from(notifications).where(and(eq(notifications.userId, reader), eq(notifications.threadId, topic.id), isNull(notifications.readAt)));
    expect(unread).toMatchObject([{ firstEntryId: next.id, mergedCount: 1 }]);
  }, 30_000);
});
