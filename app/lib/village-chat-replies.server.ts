import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatMessages, chatMessageTranslations, profiles } from "./db/schema";
import { selectDisplayName } from "./display-names.server";
import { chatReplyExcerpt, type ChatReply, type ChatMessage } from "./village-chat";
import { chatSourceHash, neededChatLanguage } from "./village-chat-translations.server";

// The caller has checked this reader's chat access. Only current rows in this village
// are used; fetching a preview never requests a translation or expands AI context.
export async function chatRepliesFor(db: Db, villageId: string, userId: string, messages: Array<typeof chatMessages.$inferSelect>) {
  const ids = [...new Set(messages.filter(message => !message.deletedAt && !message.hiddenAt).flatMap(message => message.replyToId ? [message.replyToId] : []))];
  const replies = new Map<string, ChatReply>();
  if (!ids.length) return replies;
  const rows = await db.select({ message: chatMessages, handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea })
    .from(chatMessages).leftJoin(profiles, eq(profiles.userId, chatMessages.authorId))
    .where(and(eq(chatMessages.villageId, villageId), inArray(chatMessages.id, ids)));
  const [reader] = await db.select({ displayLang: profiles.displayLang, readLangs: profiles.readLangs, uiLocale: profiles.uiLocale }).from(profiles).where(eq(profiles.userId, userId));
  const translations = await db.select().from(chatMessageTranslations).where(and(inArray(chatMessageTranslations.messageId, ids), eq(chatMessageTranslations.state, "ready")));
  for (const row of rows) {
    const message = row.message;
    if (message.deletedAt || message.hiddenAt) {
      replies.set(message.id, { id: message.id, changedSeq: message.changedSeq, unavailable: true });
      continue;
    }
    const lang = reader && message.authorId !== userId ? neededChatLanguage(message.lang, reader) : null;
    const translated = lang ? translations.find(t => t.messageId === message.id && t.lang === lang && t.sourceHash === chatSourceHash(message.body) && t.text !== null) : undefined;
    replies.set(message.id, { id: message.id, changedSeq: message.changedSeq, unavailable: false, author: row.handle ?? "", authorName: selectDisplayName(row), text: chatReplyExcerpt(translated?.text ?? message.body), lang: translated?.lang ?? message.lang, editedAt: message.editedAt?.toISOString() ?? null });
  }
  return replies;
}

export function withChatReply(message: ChatMessage, replyToId: string | null, replies: ReadonlyMap<string, ChatReply>): ChatMessage {
  return message.deleted || message.hidden || !replyToId ? message : { ...message, reply: replies.get(replyToId) ?? { id: replyToId, changedSeq: 0, unavailable: true as const } };
}
