import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, user } from "../app/lib/db/schema";
import { createReply, createTopic, editEntry } from "../app/lib/entries.server";

export async function seedEditHistory(db: Db, directory: string) {
  const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, "history_screen_author@example.com"));
  if (!author) throw new Error("Missing history fixture author");
  const now = new Date("2025-01-03T00:00:00Z");
  const topic = await createTopic(db, author.id, { title: "編集履歴の見本", body: "最初の段落です。\n\n雨の日の移動について考えます。", lang: "ja" }, { now });
  if (!topic.ok) throw new Error(topic.error);
  const edit = (body: string, minutes: number) => editEntry(db, author.id, topic.id, { title: "編集履歴の見本", body }, { now: new Date(now.getTime() + minutes * 60_000) });
  await edit("最初の段落です。\n\n中間の版にだけ残る文章です。", 31);
  await edit("最初の段落です。\n\n晴れた日の移動について考えます。", 32);
  const reply = await createReply(db, author.id, topic.id, { body: "返信の初版です。", lang: "ja" }, { now });
  if (!reply.ok) throw new Error(reply.error);
  await editEntry(db, author.id, reply.id, { body: "返信の更新版です。" }, { now: new Date(now.getTime() + 33 * 60_000) });
  await db.delete(jobs).where(sql`${jobs.payload}->>'entryId' in (${String(topic.id)}, ${String(reply.id)})`);
  // Old dates keep these owned fixtures from displacing other scenarios' posts.
  await db.update(entries).set({ lastActivityAt: now }).where(eq(entries.id, topic.id));
  fs.writeFileSync(path.join(directory, "edit-history.json"), JSON.stringify({ topic: topic.id, reply: reply.id }));
}
