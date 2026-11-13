import { isChatNotification } from "./notifications";
type Notice = { id: number; kind: string; read: boolean; actorHandle: string | null; chat?: { slug: string } };

// Keep chronological runs and read states separate. The link opens the oldest addressed message in the run.
export function groupChatNotifications<T extends Notice>(items: readonly T[]): Array<T & { chatHandles: string[]; chatCount: number; chatHasReply: boolean }> {
  const groups: Array<T & { chatHandles: string[]; chatCount: number; chatHasReply: boolean }> = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const handlesForItem = item.actorHandle ? [item.actorHandle] : [];
    if (isChatNotification(item.kind) && item.chat && previous && isChatNotification(previous.kind) && previous.chat?.slug === item.chat.slug && previous.read === item.read) {
      const handles = previous.chatHandles.length && handlesForItem.length ? [...new Set([...previous.chatHandles, ...handlesForItem])] : [];
      groups[groups.length - 1] = { ...previous, id: item.id, chat: item.chat, chatHandles: handles, chatCount: previous.chatCount + 1, chatHasReply: previous.chatHasReply || item.kind === "chat_reply" };
    } else groups.push({ ...item, chatHandles: isChatNotification(item.kind) ? handlesForItem : [], chatCount: 1, chatHasReply: item.kind === "chat_reply" });
  }
  return groups;
}
