import { chatReplyFromMessage, type ActiveChatMessage, type ChatMessage, type ChatReply } from "./village-chat";

export const CHAT_MESSAGE_LIMIT = 300;
type Tombstone = { createdSeq: number; changedSeq: number };
export type ChatMessageWindow = { messages: ActiveChatMessage[]; deleted: Record<string, Tombstone>; unavailableReplies: Record<string, number>; olderCut: number | null; newerCut: number | null };
export const emptyChatWindow = (): ChatMessageWindow => ({ messages: [], deleted: {}, unavailableReplies: {}, olderCut: null, newerCut: null });

// Keep the reader's anchor while bounding retained bodies. Cut edges are fetched
// again through ordinary history/continuation cursors, without changing read coverage.
export function mergeChatMessages(old: ChatMessageWindow, incoming: readonly ChatMessage[], options: { edge?: "older" | "newer"; anchor?: number; onlyExisting?: boolean; minimumSeq?: number } = {}): ChatMessageWindow {
  const map = new Map(old.messages.map(message => [message.id, message]));
  const deleted = { ...old.deleted };
  const replies = new Map<string, ChatReply>();
  const keepReply = (reply: ChatReply) => {
    if ((replies.get(reply.id)?.changedSeq ?? -1) <= reply.changedSeq) replies.set(reply.id, reply);
  };
  for (const message of [...old.messages, ...incoming]) if (!message.deleted && message.reply) keepReply(message.reply);
  for (const [id, tombstone] of Object.entries(old.deleted)) keepReply({ id, changedSeq: tombstone.changedSeq, unavailable: true });
  for (const [id, changedSeq] of Object.entries(old.unavailableReplies)) keepReply({ id, changedSeq, unavailable: true });
  // Even a changed parent outside the retained window refreshes its loaded replies.
  for (const message of [...old.messages, ...incoming]) keepReply(chatReplyFromMessage(message));
  for (const message of incoming) {
    const previous = map.get(message.id);
    if (Math.max(previous?.changedSeq ?? -1, deleted[message.id]?.changedSeq ?? -1) > message.changedSeq) continue;
    if (message.deleted) { map.delete(message.id); deleted[message.id] = { createdSeq: message.createdSeq, changedSeq: message.changedSeq }; continue; }
    if (deleted[message.id]?.changedSeq === message.changedSeq || options.onlyExisting && !previous || !previous && message.createdSeq < (options.minimumSeq ?? 0)) continue;
    delete deleted[message.id];
    if (!previous || JSON.stringify(previous) !== JSON.stringify(message)) map.set(message.id, message);
  }
  for (const message of map.values()) {
    const reply = message.reply && replies.get(message.reply.id);
    if (reply && JSON.stringify(reply) !== JSON.stringify(message.reply)) map.set(message.id, { ...message, reply });
  }
  // Retain body-free visibility revisions even when the parent and all its replies
  // are outside this window; a delayed history response must not restore a hidden quote.
  const unavailableReplies = Object.fromEntries([...replies].flatMap(([id, reply]) => reply.unavailable ? [[id, reply.changedSeq]] : []));
  const sorted = [...map.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  let start = 0;
  if (sorted.length > CHAT_MESSAGE_LIMIT) {
    const anchor = options.anchor === undefined ? -1 : sorted.findIndex(message => message.createdSeq >= options.anchor!);
    start = options.edge === "older" ? 0 : options.edge === "newer" || anchor < 0 ? sorted.length - CHAT_MESSAGE_LIMIT : Math.max(0, Math.min(sorted.length - CHAT_MESSAGE_LIMIT, anchor - Math.floor(CHAT_MESSAGE_LIMIT / 2)));
  }
  const messages = sorted.slice(start, start + CHAT_MESSAGE_LIMIT);
  const first = messages[0]?.createdSeq ?? 0, last = messages.at(-1)?.createdSeq ?? 0;
  let olderCut = old.olderCut !== null && messages.length > 0 && first <= old.olderCut ? null : old.olderCut;
  let newerCut = old.newerCut !== null && last >= old.newerCut ? null : old.newerCut;
  if (start > 0) olderCut = sorted[start - 1].createdSeq;
  if (start + messages.length < sorted.length) newerCut = Math.max(newerCut ?? 0, sorted.at(-1)!.createdSeq);
  // Keep lightweight deletion revisions until an explicit window replacement:
  // a delayed page must never resurrect a body after its tombstone was evicted.
  if (olderCut === old.olderCut && newerCut === old.newerCut && messages.length === old.messages.length && messages.every((message, i) => message === old.messages[i]) && JSON.stringify(deleted) === JSON.stringify(old.deleted) && JSON.stringify(unavailableReplies) === JSON.stringify(old.unavailableReplies)) return old;
  return { messages, deleted, unavailableReplies, olderCut, newerCut };
}

export function mergeChatUnreadCounts(old: Record<string, number>, incoming: Record<string, number>, replace = false): Record<string, number> {
  const next = replace ? incoming : { ...old, ...incoming };
  return Object.keys(old).length === Object.keys(next).length && Object.keys(next).every(key => next[key] === old[key]) ? old : next;
}
