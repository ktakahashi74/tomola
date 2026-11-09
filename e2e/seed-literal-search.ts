import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, profiles, translations } from "../app/lib/db/schema";

export async function seedLiteralSearch(db: Db, dir: string) {
  const [author] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "zliteral_reader"));
  // Direct insertion deliberately leaves no embedding row or pending embedding job.
  const [topic] = await db.insert(entries).values({ kind: "topic", authorId: author.id, lang: "ja", title: "語句検索の読書記録", body: `${"はじめの段落。".repeat(800)}literal-browser-needle 読み返したい一節。`, sourceHash: "literal-browser-source", createdAt: new Date("2020-01-01T00:00:00Z") }).returning();
  await db.insert(translations).values([
    { entryId: topic.id, field: "title", lang: "en", kind: "human", text: "A reading note found by its words", sourceHash: topic.sourceHash },
    { entryId: topic.id, field: "body", lang: "en", kind: "human", text: "A saved translation with translated-browser-needle in its text.", sourceHash: topic.sourceHash },
  ]);
  fs.writeFileSync(path.join(dir, "literal-search.json"), JSON.stringify({ topic: topic.id }));
}
