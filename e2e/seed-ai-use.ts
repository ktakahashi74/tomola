import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { resolveEngines } from "../app/lib/llm/config.server";

export async function seedAiUse(db: Db, dir: string) {
  const [author] = await db.select().from(user).where(eq(user.email, "zai_use_author@example.com"));
  const created = await createTopic(db, author.id, { lang: "ja", title: "使う AI の説明を読む試験", body: "この架空の文章の訳から、サイトが使う AI の説明を開きます。" }, { now: new Date("2025-10-01T00:00:00Z") });
  if (!created.ok) throw new Error(created.error);
  const [entry] = await db.select().from(entries).where(eq(entries.id, created.id));
  const engine = resolveEngines().primary;
  await db.insert(translations).values((["title", "body"] as const).map(field => ({
    entryId: entry.id, field, lang: "en", kind: "primary", text: `[en] ${field === "title" ? entry.title : entry.body}`,
    sourceHash: entry.sourceHash, engine: engine.id, model: engine.model,
  })));
  fs.writeFileSync(path.join(dir, "ai-use.json"), JSON.stringify({ id: entry.id, model: engine.model }));
}
