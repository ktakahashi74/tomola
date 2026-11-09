import { expect, it } from "vitest";
import { rememberReplies, rememberViewingReplies, SEEN_REPLIES_KEY, type ReplyReadView } from "~/lib/seen-replies";

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};
const replies = (ids: number[]) => ids.map(id => ({ id, eligible: true }));

it("marks every unseen other reply after a return, never the first visit or one's own reply", () => {
  const store = storage();
  expect(rememberReplies(store, 1, replies([10]))).toEqual([]);
  expect(rememberReplies(store, 1, [{ id: 11, eligible: false }, ...replies([12, 13])])).toEqual([12, 13]);
  expect(rememberReplies(store, 1, replies([12, 13]))).toEqual([]);
  expect(rememberReplies(store, 2, [])).toEqual([]);
  expect(rememberReplies(store, 2, replies([14]))).toEqual([14]);
});
it("keeps the maximum when going back a page and retains only the most recent 500 topics", () => {
  const store = storage();
  rememberReplies(store, 1, replies([100]));
  rememberReplies(store, 1, replies([10]));
  expect(rememberReplies(store, 1, replies([90]))).toEqual([]);
  for (let id = 2; id <= 501; id++) rememberReplies(store, id, replies([id]));
  const data = JSON.parse(store.getItem(SEEN_REPLIES_KEY)!);
  expect(data).toHaveLength(500);
  expect(data[0][0]).toBe(2);
  expect(rememberReplies(store, 1, replies([200]))).toEqual([]);
});
it("treats corrupt storage as a first visit and ignores blocked storage", () => {
  for (const value of ["broken", "{}", "null", '[[-1,2],[1,"bad"]]']) {
    const store = storage(); store.setItem(SEEN_REPLIES_KEY, value);
    expect(rememberReplies(store, 1, replies([10]))).toEqual([]);
  }
  expect(rememberReplies({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }, 1, replies([10]))).toEqual([]);
  expect(rememberReplies({ getItem: () => "[[1,2]]", setItem: () => { throw new Error("full"); } }, 1, replies([10]))).toEqual([]);
});

it("keeps a viewing session's new IDs through revalidation and temporary filters, excluding hidden and own replies", () => {
  const store = storage();
  rememberReplies(store, 1, replies([10]));
  const view: ReplyReadView = {};
  expect(rememberViewingReplies(store, 1, replies([11, 12]), view)).toEqual([11, 12]);
  expect(rememberViewingReplies(store, 1, replies([11, 12, 13]), view)).toEqual([11, 12]);
  expect(rememberViewingReplies(store, 1, replies([12]), view)).toEqual([12]);
  expect(rememberViewingReplies(store, 1, [{ id: 11, eligible: false }, ...replies([12])], view)).toEqual([12]);
  expect(rememberViewingReplies(store, 1, replies([11, 12]), view)).toEqual([11, 12]);
  // A different topic/page or full reload creates a fresh view object.
  expect(rememberViewingReplies(store, 1, replies([11, 12]), {})).toEqual([]);
  expect(rememberViewingReplies(store, 2, replies([20]), {})).toEqual([]);
  const firstVisit: ReplyReadView = {};
  expect(rememberViewingReplies(store, 3, replies([30]), firstVisit)).toEqual([]);
  expect(rememberViewingReplies(store, 3, replies([30, 31]), firstVisit)).toEqual([]);
});

it("uses displayed order for the first new reply and the maximum ID for the watermark", () => {
  const store = storage();
  rememberReplies(store, 1, replies([10]));
  const view: ReplyReadView = {};
  expect(rememberViewingReplies(store, 1, replies([11, 15, 12]), view)).toEqual([11, 15, 12]);
  expect(JSON.parse(store.getItem(SEEN_REPLIES_KEY)!)).toEqual([[1, 15]]);
  expect(rememberViewingReplies(store, 1, replies([12, 11, 16]), view)).toEqual([12, 11]);
  expect(rememberViewingReplies(store, 1, replies([15]), {})).toEqual([]);
  expect(rememberViewingReplies(store, 1, replies([17, 18]), {})).toEqual([17, 18]);
});
