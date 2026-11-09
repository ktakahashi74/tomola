import { isContentKind } from "./notifications";

type Notice = { id: number; kind: string; read: boolean; threadId: number | null; entryId: number | null; unavailable: boolean; actorHandle: string | null };
export type ThreadGroup = { threadSize: number; threadOldestId: number; threadHandles: string[]; threadMentionsOnly: boolean };

// While they are unread, the notices about one post (replies to it, replies to a reply in it, mentions in it, new replies in it when it is followed) are one row.
// The row stands in the place of the newest; it opens at the oldest unread reply (a mention in the post itself comes after replies; its id is threadOldestId), and opening it reads all of them.
// Read notices stay one by one. Notices that cannot be shown (the post is hidden or deleted) stay one by one too.
export function groupThreadNotifications<T extends Notice>(items: readonly T[]): Array<T & ThreadGroup> {
  const groups = new Map<number, { index: number; ids: number[]; replies: number[]; handles: string[]; mentionsOnly: boolean }>();
  const isReply = (item: Notice) => item.entryId !== null && item.entryId !== item.threadId;
  const out: Array<T & ThreadGroup> = [];
  for (const item of items) {
    const groupable = !item.read && !item.unavailable && item.threadId !== null && item.kind !== "response_to_topic" && isContentKind(item.kind);
    const existing = groupable ? groups.get(item.threadId!) : undefined;
    if (existing) {
      existing.ids.push(item.id);
      if (isReply(item)) existing.replies.push(item.id);
      if (item.kind !== "mention") existing.mentionsOnly = false;
      if (item.actorHandle && !existing.handles.includes(item.actorHandle)) existing.handles.push(item.actorHandle);
      continue;
    }
    if (groupable) groups.set(item.threadId!, { index: out.length, ids: [item.id], replies: isReply(item) ? [item.id] : [], handles: item.actorHandle ? [item.actorHandle] : [], mentionsOnly: item.kind === "mention" });
    out.push({ ...item, threadSize: 1, threadOldestId: item.id, threadHandles: item.actorHandle ? [item.actorHandle] : [], threadMentionsOnly: item.kind === "mention" });
  }
  for (const group of groups.values()) {
    const base = out[group.index];
    out[group.index] = { ...base, threadSize: group.ids.length, threadOldestId: Math.min(...(group.replies.length ? group.replies : group.ids)), threadHandles: group.handles, threadMentionsOnly: group.mentionsOnly };
  }
  return out;
}
