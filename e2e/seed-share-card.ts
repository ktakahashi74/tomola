import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

export async function seedShareCard(db: Db, dir: string) {
  const fixtures: Record<string, { topicId: number; nextId: number }> = {};
  const at = new Date("2025-12-01T12:00:00Z");
  for (const scenario of ["guest", "member", "source"]) {
    const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, `card_${scenario}@example.com`));
    const next = await createTopic(db, member.id, { lang: "en", title: `Next article ${scenario}`, body: "An English original." }, { now: at });
    if (!next.ok) throw new Error("Share card next fixture failed");
    const link = `[Next](/t/${next.id})`;
    const topic = await createTopic(db, member.id, { lang: "ja", title: `共有の原文 ${scenario}`, body: `日本語の本文。\n\n${link}` }, { now: at });
    if (!topic.ok) throw new Error("Share card fixture failed");
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await db.insert(translations).values([
      { entryId: topic.id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: `Translated article ${scenario}` },
      { entryId: topic.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: `An English translation.\n\n${link}` },
    ]);
    fixtures[scenario] = { topicId: topic.id, nextId: next.id };
  }
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, Object.values(fixtures).flatMap(f => [f.topicId, f.nextId])));
  fs.writeFileSync(path.join(dir, "share-card.json"), JSON.stringify(fixtures));
}
