import { expect, it } from "vitest";
import { buildReplyBranches, splitReplyBranch, type ReplyParent } from "~/lib/reply-branches";

const page = (...ids: number[]) => ids.map(id => ({ id }));
const topology: ReplyParent[] = [{ id: 2, parentId: 1 }, { id: 3, parentId: null }, { id: 4, parentId: 2 }, { id: 5, parentId: 3 }, { id: 6, parentId: 4 }];
it("groups interleaved branches and flattens deeper descendants without changing membership", () => {
  expect(buildReplyBranches(1, page(2, 3, 4, 5, 6), topology)).toEqual([
    { rootId: 2, replyIds: [2, 4, 6] }, { rootId: 3, replyIds: [3, 5] },
  ]);
  expect(buildReplyBranches(1, page(2, 3, 4, 5, 6), topology, true).map(b => b.replyIds)).toEqual([[2], [3], [4], [5], [6]]);
});
it("orders continuation branches by their first member on the current page", () => {
  expect(buildReplyBranches(1, page(5, 6), topology)).toEqual([{ rootId: 3, replyIds: [5] }, { rootId: 2, replyIds: [6] }]);
});
it("keeps a deleted root as head only when it is present, without inventing an omitted placeholder", () => {
  expect(buildReplyBranches(1, page(2, 4, 6), topology)).toEqual([{ rootId: 2, replyIds: [2, 4, 6] }]);
  expect(buildReplyBranches(1, page(6), topology)).toEqual([{ rootId: 2, replyIds: [6] }]);
});
it("does not lose replies with missing, cross-thread, cyclic or downstream invalid parents", () => {
  const bad = [{ id: 2, parentId: 99 }, { id: 3, parentId: 4 }, { id: 4, parentId: 3 }, { id: 5, parentId: 3 }, { id: 6, parentId: 2 }, { id: 7, parentId: 7 }];
  expect(buildReplyBranches(1, page(2, 3, 4, 5, 6, 7, 8), bad)).toEqual([2, 3, 4, 5, 6, 7, 8].map(id => ({ rootId: id, replyIds: [id] })));
});
it("resolves a long valid chain iteratively, including ancestors outside the page", () => {
  const chain = Array.from({ length: 30_000 }, (_, i) => ({ id: i + 2, parentId: i + 1 }));
  expect(buildReplyBranches(1, page(30_001, 30_000), chain)).toEqual([{ rootId: 2, replyIds: [30_001, 30_000] }]);
});
it("folds only the tail of long branches, retaining the head and initial children", () => {
  expect(splitReplyBranch([1, 2, 3])).toEqual({ shown: [2, 3], folded: [] });
  const { shown, folded } = splitReplyBranch([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(shown.length).toBeGreaterThan(0);
  expect(folded.length).toBeGreaterThan(0);
  expect([1, ...shown, ...folded]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
