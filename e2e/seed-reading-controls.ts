import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { setVote } from "../app/lib/votes.server";
import { setFollow } from "../app/lib/follows.server";

export async function seedReadingControls(db: Db, dir: string) {
  const fixtures: Record<string, { topicId: number; ownReplyId: number; otherReplyId: number; englishId: number }> = {};
  const at = new Date("2025-12-01T12:00:00Z");
  for (const scenario of ["lists", "actions", "author", "panels", "ownership"]) {
    const ids: Record<string, string> = {};
    for (const role of ["writer", "reader", "voter"]) {
      const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, `reading_controls_${scenario}_${role}@example.com`));
      ids[role] = member.id;
    }
    const topic = await createTopic(db, ids.writer, { lang: "ja", title: `操作の確認 ${scenario}`, body: "操作を確認するための本文。" }, { now: at });
    const english = await createTopic(db, ids.writer, { lang: "en", title: `Reading controls ${scenario}`, body: "Original English text." }, { now: at });
    if (!topic.ok || !english.ok) throw new Error("reading controls topics failed");
    const own = await createReply(db, ids.reader, topic.id, { lang: "en", body: "An owned reply." }, { now: at });
    const other = await createReply(db, ids.writer, topic.id, { lang: "ja", body: "別の人の返信。" }, { now: at });
    if (!own.ok || !other.ok) throw new Error("reading controls replies failed");
    for (const [id, title] of [[topic.id, `Translated reading controls ${scenario}`], [other.id, null]] as const) {
      const [source] = await db.select().from(entries).where(eq(entries.id, id));
      await db.insert(translations).values([
        { entryId: id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "A translated passage." },
        ...(title ? [{ entryId: id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: title }] : []),
      ]);
    }
    await setFollow(db, ids.reader, english.id, true);
    for (const voter of [ids.reader, ids.voter]) await setVote(db, voter, topic.id, true);
    fixtures[scenario] = { topicId: topic.id, ownReplyId: own.id, otherReplyId: other.id, englishId: english.id };
  }
  const entryIds = Object.values(fixtures).flatMap(f => [f.topicId, f.englishId, f.ownReplyId, f.otherReplyId]);
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, entryIds));
  fs.writeFileSync(path.join(dir, "reading-controls.json"), JSON.stringify(fixtures));
}
