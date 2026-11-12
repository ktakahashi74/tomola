import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

export async function seedReadingCounts(db: Db, dir: string) {
  const ids: number[] = [];
  for (const name of ["first", "next", "hidden", "landing"]) {
    const [author] = await db.select().from(user).where(eq(user.email, `reading_counts_${name === "next" ? "first" : name}@example.com`));
    const topic = await createTopic(db, author.id, { lang: "ja", title: `Reading counts ${name}`, body: `読む回数 ${name}。` }, { now: new Date("2025-10-01T00:00:00Z") });
    if (!topic.ok) throw new Error(topic.error);
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await db.insert(translations).values({ entryId: topic.id, lang: "en", field: "body", kind: "primary", text: `Reading counts body ${name}.`, sourceHash: source.sourceHash, engine: "fake" });
    ids.push(topic.id);
  }
  fs.writeFileSync(path.join(dir, "reading-counts.json"), JSON.stringify(ids));
}
