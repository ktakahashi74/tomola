export const SEEN_REPLIES_KEY = "tomola.seen-replies";
export type SeenReply = { id: number; eligible: boolean };
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export type ReplyReadView = { ids?: readonly number[] };

// Freeze the initially new IDs for this topic/page viewing session. Filters and
// revalidation only intersect that set with the currently displayed replies.
// Persist the maximum on every read, independently of the grouped screen order.
export function rememberViewingReplies(storage: StorageAccess, threadId: number, replies: readonly SeenReply[], view: ReplyReadView): number[] {
  const ids = rememberReplies(storage, threadId, replies);
  view.ids ??= ids;
  const initiallyNew = new Set(view.ids);
  return replies.filter(reply => reply.eligible && initiallyNew.has(reply.id)).map(reply => reply.id);
}

// An MRU list of [topic ID, maximum displayed reply ID], bounded to 500 topics.
// Call only in the browser. Neither a reading record nor its watermark is sent.
export function rememberReplies(storage: StorageAccess, threadId: number, replies: readonly SeenReply[]): number[] {
  try {
    let saved: unknown;
    try { saved = JSON.parse(storage.getItem(SEEN_REPLIES_KEY) ?? "[]"); } catch { saved = []; }
    const records = new Map<number, number>();
    if (Array.isArray(saved)) for (const item of saved.slice(-500)) {
      if (Array.isArray(item) && item.length === 2 && Number.isSafeInteger(item[0]) && item[0] > 0 && Number.isSafeInteger(item[1]) && item[1] >= 0) {
        records.set(item[0], Math.max(records.get(item[0]) ?? 0, item[1]));
      }
    }
    const previous = records.get(threadId);
    const ids = previous === undefined ? [] : replies.filter(r => r.eligible && r.id > previous).map(r => r.id);
    const maximum = replies.reduce((max, r) => Math.max(max, r.id), previous ?? 0);
    records.delete(threadId);
    records.set(threadId, maximum);
    storage.setItem(SEEN_REPLIES_KEY, JSON.stringify([...records].slice(-500)));
    return ids;
  } catch {
    return [];
  }
}
