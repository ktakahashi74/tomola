type Notice = { id: number; kind: string; read: boolean; actorHandle: string | null; chat?: { slug: string } };

// Keep chronological runs and read states separate. The link opens the oldest mention in the run.
export function groupChatNotifications<T extends Notice>(items: readonly T[]): Array<T & { chatHandles: string[]; chatCount: number }> {
  const groups: Array<T & { chatHandles: string[]; chatCount: number }> = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const handlesForItem = item.actorHandle ? [item.actorHandle] : [];
    if (item.kind === "chat_mention" && item.chat && previous?.kind === "chat_mention" && previous.chat?.slug === item.chat.slug && previous.read === item.read) {
      const handles = previous.chatHandles.length && handlesForItem.length ? [...new Set([...previous.chatHandles, ...handlesForItem])] : [];
      groups[groups.length - 1] = { ...previous, id: item.id, chat: item.chat, chatHandles: handles, chatCount: previous.chatCount + 1 };
    } else groups.push({ ...item, chatHandles: item.kind === "chat_mention" ? handlesForItem : [], chatCount: 1 });
  }
  return groups;
}
