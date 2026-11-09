import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";

export async function seedReadingColumn(db: Db, dir: string) {
  const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, "column_layout@example.com"));
  const at = new Date("2025-12-01T12:00:00Z");
  const body = "## 本文の列\n\n本文と操作を同じ列に揃え、節から返信まで読み進める。";
  const translatedBody = "## The reading column\n\nThe text and its actions share a column, from the article to the replies.";
  const topic = await createTopic(db, member.id, { lang: "ja", title: "読む本文と操作の列を揃える", body }, { now: at });
  const english = await createTopic(db, member.id, { lang: "en", title: "Align the text and its actions in one reading column", body: translatedBody }, { now: at });
  if (!topic.ok || !english.ok) throw new Error("reading column topics failed");
  const reply = await createReply(db, member.id, topic.id, { lang: "en", body: "A reply within the reading column." }, { now: at });
  if (!reply.ok) throw new Error("reading column reply failed");
  const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
  await db.insert(translations).values([
    { entryId: topic.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: translatedBody },
    { entryId: topic.id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "Align a translated reading column" },
  ]);
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, [topic.id, english.id, reply.id]));
  fs.writeFileSync(path.join(dir, "reading-column.json"), JSON.stringify({ topicId: topic.id, englishId: english.id }));
}
