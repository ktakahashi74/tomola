import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { jobs, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";

// Threads for e2e/ai-readiness.spec.ts: one whose replies are written in three languages, one in a single language, one with a single reply, and two posts
// holding characters the moderator list should show. Every post is here and nothing else posts to these threads.
export async function seedAiReadiness(db: Db, dir: string) {
  const idOf = async (role: string) => (await db.select({ id: user.id }).from(user).where(eq(user.email, `ai_readiness_${role}@example.com`)))[0].id;
  const writer = await idOf("writer");
  const reader = await idOf("reader");
  const at = new Date("2026-10-01T12:00:00Z");
  const ok = <T extends { ok: boolean }>(result: T, what: string) => { if (!result.ok) throw new Error(`ai readiness ${what} failed`); return result as Extract<T, { ok: true }>; };
  const topic = async (title: string) => ok(await createTopic(db, writer, { lang: "ja", title, body: "本文。" }, { now: at }), title).id;
  const reply = async (threadId: number, as: string, lang: "ja" | "en" | "th", body: string) => ok(await createReply(db, as, threadId, { lang, body }, { now: at }), body).id;
  const mixed = await topic("言語が混ざる返信");
  await reply(mixed, reader, "en", "An English reply.");
  await reply(mixed, writer, "ja", "日本語の返信。");
  await reply(mixed, reader, "th", "ตอบ");
  const single = await topic("一つの言語の返信");
  for (const body of ["一つ目。", "二つ目。", "三つ目。"]) await reply(single, reader, "ja", body);
  const one = await topic("返信が一つ");
  await reply(one, reader, "en", "One reply.");
  // The two posts the moderator list should show: a text direction control in a topic, and tag characters in a reply.
  const marked = ok(await createTopic(db, writer, { lang: "ja", title: "確かめる候補の題", body: "本文‮の途中" }), "marked").id;
  // Review candidates must stay inside the rolling review window, like their parent topic.
  const taggedReply = ok(await createReply(db, reader, marked, { lang: "en", body: `A reply${String.fromCodePoint(0xe0041, 0xe0042)}` }), "tagged reply").id;
  const ids = [mixed, single, one, marked, taggedReply];
  await db.delete(jobs).where(inArray(sql<number>`coalesce((${jobs.payload}->>'entryId')::bigint, 0)`, ids));
  fs.writeFileSync(path.join(dir, "ai-readiness.json"), JSON.stringify({ mixed, single, one, marked, taggedReply }));
}
