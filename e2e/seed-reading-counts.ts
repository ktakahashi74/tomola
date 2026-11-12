import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, translations, user } from "../app/lib/db/schema";
import { sourceHash } from "../app/lib/source-hash.server";
import { REPLIES_PER_PAGE } from "../app/lib/pagination";
import { createTopic } from "../app/lib/entries.server";

export async function seedReadingCounts(db: Db, dir: string) {
  const ids: number[] = [];
  for (const name of ["first", "next", "hidden", "landing"]) {
    const [author] = await db.select().from(user).where(eq(user.email, `reading_counts_${name === "next" ? "first" : name}@example.com`));
    const topic = await createTopic(db, author.id, { lang: "ja", title: `Reading counts ${name}`, body: `読む回数 ${name}。` }, { now: new Date("2025-10-01T00:00:00Z") });
    if (!topic.ok) throw new Error(topic.error);
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await db.insert(translations).values({ entryId: topic.id, lang: "en", field: "body", kind: "primary", text: `Reading counts body ${name}.`, sourceHash: source.sourceHash, engine: "fake" });
    if (name === "first") {
      const body = "頁送りを確かめる返信。";
      const hash = sourceHash(null, body, "ja");
      const replies = await db.insert(entries).values(Array.from({ length: REPLIES_PER_PAGE + 1 }, () => ({
        kind: "reply" as const, threadId: topic.id, authorId: author.id, lang: "ja", body, sourceHash: hash,
        createdAt: new Date("2025-10-01T00:00:00Z"),
      }))).returning({ id: entries.id });
      // Pagination must not spend the shared anonymous translation allowance.
      await db.insert(translations).values(replies.map(reply => ({
        entryId: reply.id, lang: "en", field: "body", kind: "primary" as const, text: "Reading pagination fixture.", sourceHash: hash, engine: "fake",
      })));
    }
    ids.push(topic.id);
  }
  fs.writeFileSync(path.join(dir, "reading-counts.json"), JSON.stringify(ids));
}
