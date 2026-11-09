import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createProfile } from "../app/lib/profiles.server";
import { createFakeEngine } from "../app/lib/llm/engines/fake.server";

export async function seedWritingLanguage(db: Db, dir: string) {
  const author = "seed-writing-language-author";
  await db.insert(user).values({ id: author, name: "", email: "writing_language_author@example.com", emailVerified: true });
  const profile = await createProfile(db, author, { handle: "writing_language_author", homeArea: "ja", readLangs: ["ja", "en"] });
  if (!profile.ok) throw new Error(profile.error);
  const title = "読む言語の切り替え";
  const body = "原文で読む設定がある記事。\n\nふだんの言語の訳を選んで読める。";
  const made = await createTopic(db, author, { lang: "ja", title, body });
  if (!made.ok) throw new Error(made.error);
  const [source] = await db.select({ sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, made.id));
  const engine = createFakeEngine();
  for (const field of ["title", "body"] as const) {
    const translated = await engine.translate({ from: "ja", to: "en", text: field === "title" ? title : body });
    await db.insert(translations).values({ entryId: made.id, field, lang: "en", kind: "primary", engine: "fake", text: translated.text, ...source });
  }
  const replyBody = "An English reply kept in its original language.";
  const reply = await createReply(db, author, made.id, { lang: "en", body: replyBody });
  if (!reply.ok) throw new Error(reply.error);
  const [replySource] = await db.select({ sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, reply.id));
  const translated = await engine.translate({ from: "en", to: "ja", text: replyBody });
  await db.insert(translations).values({ entryId: reply.id, field: "body", lang: "ja", kind: "primary", engine: "fake", text: translated.text, ...replySource });
  for (const id of [made.id, reply.id]) await db.delete(jobs).where(sql`${jobs.payload}->>'entryId' = ${String(id)}`);
  fs.writeFileSync(path.join(dir, "writing-language.json"), JSON.stringify({ id: made.id, lang: "ja", title, body, reply: { id: reply.id, body: replyBody } }));
}
