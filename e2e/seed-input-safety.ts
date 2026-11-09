import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

export async function seedInputSafety(db: Db, dir: string) {
  const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, "safety_fix_edit@example.com"));
  const topic = await createTopic(db, author.id, { body: "First line.\r\nSecond line.", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  fs.writeFileSync(path.join(dir, "input-safety.json"), JSON.stringify({ crlfId: topic.id }));
}
