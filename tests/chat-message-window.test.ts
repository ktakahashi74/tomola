import { expect, it } from "vitest";
import { mergeChatMessages, emptyChatWindow, CHAT_MESSAGE_LIMIT, mergeChatUnreadCounts } from "~/lib/chat-message-window";
import type { ActiveChatMessage } from "~/lib/village-chat";
const message = (seq: number, changedSeq = seq): ActiveChatMessage => ({ id: String(seq), createdSeq: seq, changedSeq, createdAt: new Date(seq * 1000).toISOString(), author: "writer", own: false, lang: "en", parts: [{ type: "text", text: `Message ${changedSeq}` }], translation: null, edited: false, deleted: false, hidden: false });
it("keeps the newest revision, removes deleted bodies, and rejects stale resurrection", () => {
  const initial = mergeChatMessages(emptyChatWindow(), [message(2), message(1)]);
  const updated = mergeChatMessages(initial, [message(1, 4), { id: "2", createdSeq: 2, changedSeq: 5, deleted: true }]);
  expect(updated.messages.map(m => m.id)).toEqual(["1"]);
  expect(updated.messages[0].changedSeq).toBe(4);
  expect(mergeChatMessages(updated, [message(1, 3), message(2)]).messages).toEqual(updated.messages);
});
it("keeps unchanged messages and counts referentially stable", () => {
  const initial = mergeChatMessages(emptyChatWindow(), [message(1)]);
  expect(mergeChatMessages(initial, [message(1)])).toBe(initial);
  const counts = { a: 1, b: 2 };
  expect(mergeChatUnreadCounts(counts, { a: 1 })).toBe(counts);
  expect(mergeChatUnreadCounts(counts, { a: 0 })).toEqual({ a: 0, b: 2 });
});
it("bounds a live window around its visible anchor and permits travel in both directions", () => {
  const all = Array.from({ length: CHAT_MESSAGE_LIMIT + 60 }, (_, i) => message(i + 1));
  const recent = mergeChatMessages(emptyChatWindow(), all, { edge: "newer" });
  expect(recent.messages).toHaveLength(CHAT_MESSAGE_LIMIT);
  expect(recent.olderCut).not.toBeNull();
  const older = mergeChatMessages(recent, all.slice(0, 60), { edge: "older" });
  expect(older.messages[0].createdSeq).toBe(1);
  expect(older.newerCut).toBe(all.at(-1)!.createdSeq);
  const returned = mergeChatMessages(older, all.slice(-60), { edge: "newer" });
  expect(returned.messages.at(-1)?.createdSeq).toBe(all.at(-1)!.createdSeq);
  expect(returned.newerCut).toBeNull();
  const anchored = mergeChatMessages(emptyChatWindow(), all, { anchor: 2 });
  expect(anchored.messages.some(m => m.createdSeq === 2)).toBe(true);
});
it("historical polling updates only loaded messages and does not inject ancient arrivals", () => {
  const initial = mergeChatMessages(emptyChatWindow(), [message(10)]);
  expect(mergeChatMessages(initial, [message(10, 30), message(11)], { onlyExisting: true }).messages.map(m => m.createdSeq)).toEqual([10]);
  expect(mergeChatMessages(initial, [message(1, 50)], { minimumSeq: 10 }).messages).toEqual(initial.messages);
});
it("retains both recovery cursors when every retained body is deleted", () => {
  const recent = mergeChatMessages(emptyChatWindow(), Array.from({ length: 350 }, (_, i) => message(i + 1)), { edge: "newer" });
  const removed = mergeChatMessages(recent, recent.messages.map(m => ({ id: m.id, createdSeq: m.createdSeq, changedSeq: 1000 + m.createdSeq, deleted: true })));
  expect(removed.messages).toEqual([]);
  expect(removed.olderCut).toBe(recent.olderCut);
  const recovered = mergeChatMessages(removed, [message(50)], { edge: "older" });
  expect(recovered.messages[0].createdSeq).toBe(50);
});
it("does not resurrect a deleted body after many unrelated deletion events", () => {
  let current = mergeChatMessages(emptyChatWindow(), [message(200)]);
  current = mergeChatMessages(current, [{ id: "200", createdSeq: 200, changedSeq: 1000, deleted: true }]);
  current = mergeChatMessages(current, Array.from({ length: 301 }, (_, i) => ({ id: `removed-${i}`, createdSeq: 400 + i, changedSeq: 1001 + i, deleted: true })));
  expect(mergeChatMessages(current, [message(200)]).messages).toEqual([]);
});
