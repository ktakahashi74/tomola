import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createTopic, createReply } from "../app/lib/entries.server";
import { REPLIES_PER_PAGE } from "../app/lib/pagination";

export async function seedTranslationReportResults(db: Db, dir: string) {
  const fixtures: Record<string, { topicId: number; replyId: number; title: string }> = {};
  for (const size of ["wide", "narrow"]) {
    const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, `zresult_${size}_author@example.com`));
    const title = `Report result ${size}`;
    const base = new Date("2025-01-01T00:00:00Z");
    const topic = await createTopic(db, author.id, { lang: "ja", title, body: "誤訳の結果を読むための専用の話題。" }, { now: base });
    if (!topic.ok) throw new Error(topic.error);
    await db.insert(entries).values(Array.from({ length: REPLIES_PER_PAGE }, (_, i) => ({ kind: "reply", threadId: topic.id, parentId: topic.id, authorId: author.id, lang: "ja", body: `順番を保つ返信 ${i}`, createdAt: new Date(base.getTime() + i + 1) })));
    const reply = await createReply(db, author.id, topic.id, { lang: "ja", body: `報告する返信 ${size}` }, { now: new Date(base.getTime() + REPLIES_PER_PAGE + 1) });
    if (!reply.ok) throw new Error(reply.error);
    for (const id of [topic.id, reply.id]) {
      const [source] = await db.select().from(entries).where(eq(entries.id, id));
      for (const lang of ["en", "fr"]) {
        await db.insert(translations).values({ entryId: id, kind: "primary", field: "body", lang, engine: "fake", model: "fake-1", text: `[${lang}] ${source.body}`, sourceHash: source.sourceHash, mentionRevision: source.mentionRevision });
        if (id === topic.id) await db.insert(translations).values({ entryId: id, kind: "primary", field: "title", lang, engine: "fake", model: "fake-1", text: title, sourceHash: source.sourceHash, mentionRevision: source.mentionRevision });
      }
    }
    await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, [topic.id, reply.id]));
    fixtures[size] = { topicId: topic.id, replyId: reply.id, title };
  }
  fs.writeFileSync(path.join(dir, "translation-report-results.json"), JSON.stringify(fixtures));
}
