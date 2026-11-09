import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

export async function seedCrossLanguage(db: Db, dir: string) {
  const fixture: Record<string, number> = {};
  for (const name of ["share", "native", "prompt"]) {
    const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, `cross_${name}@example.com`));
    const topic = await createTopic(db, member.id, { lang: "ja", title: "言葉を越えて読む", body: "異なる言語で同じ文章を読み、一緒に考える。" }, { now: new Date("2025-12-01T12:00:00Z") });
    if (!topic.ok) throw new Error("Cross-language fixture failed");
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await db.insert(translations).values([
      { entryId: topic.id, field: "title", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "Reading across languages" },
      { entryId: topic.id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: "Read the same text across languages and think together." },
    ]);
    fixture[name] = topic.id;
  }
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, Object.values(fixture)));
  fs.writeFileSync(path.join(dir, "cross-language.json"), JSON.stringify(fixture));
}
