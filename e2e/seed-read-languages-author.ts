import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { markTranslationsSeen } from "../app/lib/translation-on-read.server";

export async function seedReadLanguagesAuthor(db: Db, dir: string) {
  const [writer] = await db.select().from(user).where(eq(user.email, "reach_writer@example.com"));
  const [reader] = await db.select().from(user).where(eq(user.email, "reach_reader@example.com"));
  const now = new Date("2025-11-02T00:00:00Z");
  const fixtures: Record<string, number> = {};
  for (const [name, title, langs] of [
    ["seen", "言語を越えて届いた投稿", ["en", "fr"]],
    ["one", "一つの言語に届いた投稿", ["en"]],
    ["unseen", "まだ本文が読まれていない投稿", []],
  ] as const) {
    const result = await createTopic(db, writer.id, { lang: "ja", title, body: `${title}。本文です。` }, { now });
    if (!result.ok) throw new Error(result.error);
    fixtures[name] = result.id;
    const [source] = await db.select().from(entries).where(eq(entries.id, result.id));
    for (const lang of langs) {
      const [row] = await db.insert(translations).values({ entryId: source.id, field: "body", lang, kind: "primary", text: `[${lang}] ${source.body}`, sourceHash: source.sourceHash, mentionRevision: source.mentionRevision }).returning();
      await markTranslationsSeen(db, [{ ...source, kind: "topic", lang: "ja" }], lang, [row.id], reader.id, now);
    }
    if (name === "unseen") {
      // Seeing only a title or a reply must not count as reading the topic body.
      const [titleRow] = await db.insert(translations).values({ entryId: source.id, field: "title", lang: "en", kind: "primary", text: "Unread body", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision }).returning();
      await markTranslationsSeen(db, [{ ...source, kind: "topic", lang: "ja" }], "en", [titleRow.id], reader.id, now);
      const reply = await createReply(db, writer.id, source.id, { lang: "ja", body: "返信だけが読まれた場合。" }, { now });
      if (!reply.ok) throw new Error(reply.error);
      const [replySource] = await db.select().from(entries).where(eq(entries.id, reply.id));
      const [replyRow] = await db.insert(translations).values({ entryId: reply.id, field: "body", lang: "en", kind: "primary", text: "A reply", sourceHash: replySource.sourceHash, mentionRevision: replySource.mentionRevision }).returning();
      await markTranslationsSeen(db, [{ ...replySource, kind: "reply", lang: "ja" }], "en", [replyRow.id], reader.id, now);
    }
  }
  const [selfWriter] = await db.select().from(user).where(eq(user.email, "reach_self_writer@example.com"));
  for (const name of ["member", "anonymous"]) {
    const result = await createTopic(db, selfWriter.id, { lang: "ja", title: `訳の確認 ${name}`, body: `書き手が最初に訳を確かめる投稿 ${name}。` }, { now });
    if (!result.ok) throw new Error(result.error);
    fixtures[`self_${name}`] = result.id;
    const [source] = await db.select().from(entries).where(eq(entries.id, result.id));
    await db.insert(translations).values({ entryId: source.id, field: "body", lang: "fr", kind: "primary", text: "Un texte traduit pour les lecteurs.", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision });
  }
  await db.delete(jobs).where(and(inArray(jobs.kind, ["translate_entry", "translate_title"]), sql`${jobs.payload}->>'entryId' in (${sql.join(Object.values(fixtures).map(id => sql`${String(id)}`), sql`, `)})`));
  fs.writeFileSync(path.join(dir, "read-languages-author.json"), JSON.stringify(fixtures));
}
