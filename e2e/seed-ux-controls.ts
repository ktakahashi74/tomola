import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";

export async function seedUxControls(db: Db, dir: string) {
  const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, "ux_author@example.com"));
  const [question] = await db.select({ id: entries.id }).from(entries).where(eq(entries.title, "Latest question fixture"));
  if (!question) throw new Error("Reply interaction question fixture is missing");
  const topic = await createTopic(db, author.id, { title: "題の報告の試験", body: "これは訳の報告と操作を試す投稿です。", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(db, author.id, topic.id, { body: "これは操作を試す返信です。", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  for (const id of [topic.id, reply.id]) {
    const [source] = await db.select().from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "A translated passage for interaction checks." });
    if (id === topic.id) await db.insert(translations).values({ entryId: id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "A translated title for interaction checks." });
  }
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, [topic.id, reply.id]));
  fs.writeFileSync(path.join(dir, "ux-controls.json"), JSON.stringify({ topicId: topic.id, replyId: reply.id, questionId: question.id }));
}
