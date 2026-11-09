import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createProfile } from "../app/lib/profiles.server";

// Opt-in fixtures keep long threads out of unrelated browser tests.
export async function seedLatestReplyFixture(db: Db) {
  const authorId = "latest-reply-writer";
  await db.insert(user).values({ id: authorId, name: "", email: "latest_reply_writer@example.com", emailVerified: true });
  const profile = await createProfile(db, authorId, { handle: "averylongmemberhandleforlayout", homeArea: "en", readLangs: ["en"] });
  if (!profile.ok) throw new Error("fixture profile failed");
  for (const question of [false, true]) {
    const topic = await createTopic(db, authorId, { lang: "en", title: question ? "Latest question fixture" : "Latest reply pagination fixture", body: "A fixture for reply navigation.", asksStance: question });
    if (!topic.ok) throw new Error("fixture topic failed");
    const replyIds: number[] = [];
    for (let i = 1; i <= 205; i++) {
      const reply = await createReply(db, authorId, topic.id, {
        lang: !question && i === 101 ? "ja" : "en",
        body: question && i === 205 ? "QUESTION_REASON_SENTINEL" : !question && i === 101 ? "最新の返信の原文。" : `Fixture reply ${i}`,
        ...(question && i <= 101 ? { stanceTag: "agree" } : {}),
      }, { now: new Date(Date.UTC(2026, 9, 4, 0, 0, i)) });
      if (!reply.ok) throw new Error("fixture reply failed");
      replyIds.push(reply.id);
    }
    if (!question) {
      await db.update(entries).set({ deletedAt: new Date() }).where(inArray(entries.id, replyIds.filter((_, i) => i !== 100 && i !== 204)));
      await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, replyIds[204]));
      const [source] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, replyIds[100]));
      await db.insert(translations).values({ entryId: replyIds[100], field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, text: `Latest translated reply ${"A".repeat(200)}` });
    }
  }
  // This fixture's excerpt translation is fixed; no asynchronous worker writes.
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title"]));
}
