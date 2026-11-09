import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatMentions, chatMessages, chatTranslationReports, notifications } from "./db/schema";
import { ChatError } from "./village-chat";
import { nextChatSequence } from "./village-chat-sequence.server";
import { clearChatTranslations } from "./village-chat-translations.server";

export const CHAT_OWN_DELETE_LIMIT = 500;

// Caller holds the village lock and has checked account authority. Message
// ownership is checked here too; membership is intentionally not required.
export async function deleteChatRows(db: Db, villageId: string, userId: string, id?: string) {
  const rows = await db.select({ id: chatMessages.id, deletedAt: chatMessages.deletedAt, changedSeq: chatMessages.changedSeq }).from(chatMessages)
    .where(and(eq(chatMessages.villageId, villageId), eq(chatMessages.authorId, userId), id === undefined ? isNull(chatMessages.deletedAt) : eq(chatMessages.id, id)))
    .orderBy(asc(chatMessages.id)).limit(id === undefined ? CHAT_OWN_DELETE_LIMIT : 1).for("update");
  if (id !== undefined && !rows.length) throw new ChatError("not_found");
  const active = rows.filter(row => !row.deletedAt);
  if (!active.length) return { count: 0, seq: rows[0]?.changedSeq ?? 0 };
  const ids = active.map(row => row.id);
  await clearChatTranslations(db, ids);
  await db.delete(chatMentions).where(inArray(chatMentions.messageId, ids));
  await db.delete(notifications).where(and(eq(notifications.kind, "chat_mention"), inArray(notifications.chatMessageId, ids)));
  const now = new Date();
  // A translation-quality report is not evidence for a decision about the author, so a deleted message must not stay readable in a reviewer's queue or in the handled
  // reports: close the open or queued ones, and erase the copies (original, translation, reporter's note) of every report about the message. The report rows and the
  // record of who closed them stay.
  await db.update(chatTranslationReports).set({ status: "dismissed", handledAt: now })
    .where(and(inArray(chatTranslationReports.messageId, ids), inArray(chatTranslationReports.status, ["open", "retry"])));
  await db.update(chatTranslationReports).set({ original: null, translation: null, note: null, prunedAt: sql`coalesce(${chatTranslationReports.prunedAt}, ${now})` })
    .where(inArray(chatTranslationReports.messageId, ids));
  // Each row needs its own sequence: a change page may end in the middle of a
  // bulk deletion, and its next cursor must not skip the remaining tombstones.
  const seq = await nextChatSequence(db, villageId, active.length);
  const changes = sql`(values ${sql.join(active.map((row, i) => sql`(${row.id}::text, ${seq - active.length + i + 1}::bigint)`), sql`, `)}) as changes(id, seq)`;
  await db.update(chatMessages).set({ body: "", deletedAt: now, changedSeq: sql`changes.seq` }).from(changes)
    .where(and(sql`${chatMessages.id} = changes.id`, eq(chatMessages.villageId, villageId), eq(chatMessages.authorId, userId)));
  return { count: active.length, seq };
}
