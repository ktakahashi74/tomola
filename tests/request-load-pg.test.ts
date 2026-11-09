import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { createReply, createTopic } from "~/lib/entries.server";
import { follows, jobs, notifications, profiles, user } from "~/lib/db/schema";
import { enqueueImmediateEmails } from "~/lib/notifications.server";

describe.skipIf(!REAL_PG_URL)("bulk reply delivery on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120000);
  afterAll(async () => { await scratch?.drop(); }, 60000);
  it("queues many followers exactly once, excludes the author, and preserves email preferences and merge ordering", async () => {
    const db = await scratch.open();
    await addMember(db, "load_owner", "load_owner"); await addMember(db, "load_replier", "load_replier");
    const followers = Array.from({ length: 9000 }, (_, i) => `load_follower_${i}`);
    await db.insert(user).values(followers.map(id => ({ id, email: `${id}@example.com`, name: id })));
    await db.insert(profiles).values(followers.map((id, i) => ({ userId: id, handle: id, handleKey: id, publicId: id, homeArea: "ja", readLangs: ["ja"], emailPref: i % 2 ? "none" : "immediate" })));
    const topic = await createTopic(db, "load_owner", { lang: "ja", body: "Topic" }); if (!topic.ok) throw new Error(topic.error);
    await db.insert(follows).values(followers.map(userId => ({ userId, threadId: topic.id, state: "following" })));
    const reply = await createReply(db, "load_replier", topic.id, { lang: "ja", body: "Reply" }); if (!reply.ok) throw new Error(reply.error);
    const made = await db.select().from(notifications).where(eq(notifications.entryId, reply.id));
    expect(made).toHaveLength(followers.length + 1); expect(new Set(made.map(n => n.userId)).size).toBe(followers.length + 1);
    expect(made.some(n => n.userId === "load_replier")).toBe(false);
    const emails = await db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"));
    const immediateCount = followers.length / 2 + 1;
    expect(emails).toHaveLength(immediateCount); expect(new Set(emails.map(j => j.dedupeKey)).size).toBe(immediateCount);
    await enqueueImmediateEmails(db, made.map(n => ({ ...n, kind: n.kind as "followed_thread" }))); // Existing unfinished jobs remain single.
    expect(await db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"))).toHaveLength(immediateCount);
    await createReply(db, "load_replier", topic.id, { lang: "ja", body: "Earlier timestamp" }, { now: new Date("2026-01-01") });
    const merged = await db.select().from(notifications).where(inArray(notifications.userId, followers));
    expect(merged).toHaveLength(followers.length); expect(merged.every(n => n.mergedCount === 2 && n.firstEntryId === n.entryId)).toBe(true);
    // Each reply also creates a new immediate notification for the topic author.
    expect(await db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"))).toHaveLength(immediateCount + 1);
  }, 60000);

  it("updates the first unread reply only when its chronological first entry changes", async () => {
    const db = await scratch.open();
    for (const id of ["load_first_owner", "load_first_writer", "load_first_reader"]) await addMember(db, id, id);
    await db.execute(sql`create table first_entry_writes (notification_id integer)`);
    await db.execute(sql`create function record_first_entry_write() returns trigger language plpgsql as $$
      begin insert into first_entry_writes values (new.id); return new; end $$`);
    await db.execute(sql`create trigger first_entry_write after update of first_entry_id on notifications for each row execute function record_first_entry_write()`);
    const writes = () => db.select({ id: sql<number>`notification_id` }).from(sql`first_entry_writes`);
    const topic = await createTopic(db, "load_first_owner", { body: "First unread order", lang: "ja" });
    if (!topic.ok) throw new Error(topic.error);
    await db.insert(follows).values({ userId: "load_first_reader", threadId: topic.id, state: "following" });
    const reply = async (date: string) => {
      const result = await createReply(db, "load_first_writer", topic.id, { body: date, lang: "ja" }, { now: new Date(date) });
      if (!result.ok) throw new Error(result.error);
      return result.id;
    };
    const first = await reply("2026-02-02");
    const emails = await db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"));
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every(job => job.priority === 0)).toBe(true);
    await reply("2026-02-03");
    expect(await writes()).toHaveLength(0);
    expect((await db.select().from(notifications).where(eq(notifications.userId, "load_first_reader")))[0].firstEntryId).toBe(first);
    const earlier = await reply("2026-02-01");
    expect(await writes()).toHaveLength(1);
    expect((await db.select().from(notifications).where(eq(notifications.userId, "load_first_reader")))[0]).toMatchObject({ firstEntryId: earlier, entryId: earlier, mergedCount: 3 });
  });
});
