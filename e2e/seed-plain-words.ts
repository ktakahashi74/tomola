import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

export async function seedPlainWords(db: Db) {
  const topic = await createTopic(db, "seed-kim", { lang: "ja", title: "はじめての画面", body: "読む人のための短い原文。\n\n次の段落。" });
  const titleless = await createTopic(db, "seed-kim", { lang: "en", title: "", body: "A titleless opening with enough characters to exercise the document title limit.\n\nSecond paragraph." });
  const pending = await createTopic(db, "seed-kim", { lang: "ja", title: "訳を待つ投稿", body: "まだ訳のない本文。" });
  if (!topic.ok || !titleless.ok || !pending.ok) throw new Error("topic fixture failed");
  const replies: number[] = [];
  for (let i = 0; i < 6; i++) {
    const reply = await createReply(db, "seed-kim", topic.id, { lang: "ja", body: `返信 ${i} の引用する文。`, ...(i % 2 ? { parentId: replies[i - 1] } : {}) });
    if (!reply.ok) throw new Error("reply fixture failed");
    replies.push(reply.id);
  }
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, replies[2]));
  await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, replies[4]));
  const translatedIds = [topic.id, ...replies];
  for (const id of translatedIds) {
    const [entry] = await db.select().from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision, text: id === topic.id ? "A translated passage for a first reader.\n\nAnother paragraph." : `Translated reply ${id} with a passage to quote.` });
  }
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title", "embed_entry"]));
  const memberInvite = inviteUrl((await createInvitation(db, { email: "plain_member@example.com" })).token);
  const signupInvite = inviteUrl((await createInvitation(db, { email: "plain_signup@example.com" })).token);
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "plain-words.json"), JSON.stringify({ topicId: topic.id, titlelessId: titleless.id, pendingId: pending.id, replies, memberInvite, signupInvite }));
}
