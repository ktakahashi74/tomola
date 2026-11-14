import { alias } from "drizzle-orm/pg-core";
import { chatParts } from "./village-chat";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatMessages, chatNushiRequests, chatNushiSources, profiles, villageMembers } from "./db/schema";
import { chatNushiEnabled } from "./chat-nushi-config.server";
import type { ChatMessage } from "./village-chat";

// The chat reader has already authorized membership and the current consent.
export async function presentChatNushi(db: Db, userId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (!chatNushiEnabled()) return messages;
  const ids = messages.filter(message => !message.deleted && message.nushi).map(message => message.id);
  const calls = messages.filter(message => !message.deleted && message.own).map(message => message.id);
  const requests = calls.length ? await db.select({ messageId: chatNushiRequests.messageId, state: chatNushiRequests.state, failure: chatNushiRequests.failure }).from(chatNushiRequests).where(and(eq(chatNushiRequests.callerId, userId), inArray(chatNushiRequests.messageId, calls))) : [];
  const withCalls = messages.map(message => {
    const request = requests.find(request => request.messageId === message.id);
    return !message.deleted && request ? { ...message, nushiCall: { state: request.state, failure: request.failure } } : message;
  });
  if (!ids.length) return withCalls;
  const [preference] = await db.select({ hide: profiles.hideNushi }).from(profiles).where(eq(profiles.userId, userId));
  const answerRow = alias(chatMessages, "chat_nushi_answer");
  const rows = await db.select({ answer: answerRow, id: chatNushiRequests.answerMessageId, handle: profiles.handle, editedAt: chatMessages.editedAt }).from(chatNushiRequests)
    .innerJoin(answerRow, eq(answerRow.id, chatNushiRequests.answerMessageId)).innerJoin(chatMessages, eq(chatMessages.id, chatNushiRequests.messageId)).leftJoin(profiles, eq(profiles.userId, chatNushiRequests.callerId))
    .where(inArray(chatNushiRequests.answerMessageId, ids));
  const departed = await db.select({ id: chatNushiRequests.answerMessageId, handle: profiles.handle }).from(chatNushiSources)
    .innerJoin(chatNushiRequests, eq(chatNushiRequests.id, chatNushiSources.requestId)).leftJoin(profiles, eq(profiles.userId, chatNushiSources.authorId))
    .where(and(inArray(chatNushiRequests.answerMessageId, ids), sql`not exists (select 1 from ${villageMembers} where ${villageMembers.villageId} = ${chatNushiRequests.villageId} and ${villageMembers.userId} = ${chatNushiSources.authorId})`));
  return withCalls.map(message => {
    if (message.deleted || !message.nushi) return message;
    const row = rows.find(row => row.id === message.id);
    const hidden = message.hidden || !!preference?.hide || !row || !!row.answer.hiddenAt || !!row.answer.deletedAt;
    return { ...message, hidden, parts: hidden ? [] : chatParts(row!.answer.body), translation: hidden ? null : message.translation, reply: hidden ? null : message.reply, nushi: { caller: row?.handle ?? null, edited: !!row?.editedAt, departed: hidden ? [] : [...new Set(departed.filter(source => source.id === message.id).flatMap(source => source.handle ? [source.handle] : []))] } };
  });
}
