import { expect, it } from "vitest";
import { addChatReadRange, chatForwardRange, chatReadGaps, chatReadThrough, chatSnapshotRange } from "~/lib/chat-read-coverage";

it("does not cross unloaded intervals and resumes after overlapping history fills them", () => {
  let ranges = addChatReadRange([], { from: 0, to: 36 });
  ranges = addChatReadRange(ranges, { from: 72, to: 121 });
  expect(chatReadThrough(10, ranges)).toBe(36);
  expect(chatReadThrough(60, ranges)).toBe(60);
  ranges = addChatReadRange(ranges, { from: 22, to: 71 });
  expect(chatReadThrough(10, ranges)).toBe(121);
  expect(ranges).toEqual([{ from: 0, to: 121 }]);
});
it("treats fetched pages as covered intervals despite edit or deletion sequence gaps", () => {
  const page = { messages: [{ createdSeq: 11 }, { createdSeq: 14 }, { createdSeq: 18 }], before: 11, seq: 20, hasNewer: false, historical: false };
  const range = chatSnapshotRange(page)!;
  expect(chatReadThrough(10, [range])).toBe(20);
  expect(chatReadThrough(2, [range])).toBe(2);
  expect(chatSnapshotRange({ ...page, messages: [], historical: true })).toBeNull();
  expect(chatSnapshotRange({ ...page, messages: [], before: null })).toEqual({ from: 0, to: 20 });
});
it("keeps a new live interval separate from an unfilled send gap", () => {
  const ranges = addChatReadRange([{ from: 0, to: 36 }, { from: 72, to: 121 }], { from: 122, to: 125 });
  expect(chatReadThrough(10, ranges)).toBe(36);
  expect(chatReadThrough(121, ranges)).toBe(125);
});

it("uses the server's certified unread start without bridging explicit window gaps", () => {
  const page = { messages: [{ createdSeq: 12 }, { createdSeq: 61 }], before: 12, seq: 61, hasNewer: false, historical: false, readFrom: 10 };
  expect(chatReadThrough(10, [chatSnapshotRange(page)!])).toBe(61);
  expect(chatReadThrough(10, [chatSnapshotRange({ ...page, readFrom: null })!])).toBe(10);
  expect(chatReadThrough(10, [chatSnapshotRange({ ...page, messages: [{ createdSeq: 72 }, { createdSeq: 121 }], before: 72, seq: 121, readFrom: null })!])).toBe(10);
});

it("connects a completed continuation through non-creation events to the next live interval", () => {
  const page = { messages: [{ createdSeq: 56 }, { createdSeq: 60 }], hasNewer: false };
  const forward = chatForwardRange(55, 61, page);
  expect(forward).toEqual({ from: 56, to: 61 });
  let ranges = addChatReadRange([{ from: 5, to: 55 }], forward);
  ranges = addChatReadRange(ranges, { from: 62, to: 62 });
  expect(chatReadThrough(20, ranges)).toBe(62);
  expect(chatForwardRange(55, 61, { ...page, hasNewer: true })).toEqual({ from: 56, to: 60 });
});

it("covers the requested checkpoint even when the final continuation has no rows", () => {
  expect(chatForwardRange(60, 64, { messages: [], hasNewer: false })).toEqual({ from: 61, to: 64 });
  expect(chatForwardRange(60, 59, { messages: [{ createdSeq: 62 }], hasNewer: false })).toEqual({ from: 61, to: 62 });
});

it("locates internal gaps and advances their links as pages fill them", () => {
  let ranges = [{ from: 0, to: 36 }, { from: 172, to: 221 }];
  expect(chatReadGaps([{ createdSeq: 36 }, { createdSeq: 172 }, { createdSeq: 221 }], ranges)).toEqual([{ after: 36, before: 172 }]);
  ranges = addChatReadRange(ranges, { from: 37, to: 86 });
  expect(chatReadGaps([{ createdSeq: 36 }, { createdSeq: 86 }, { createdSeq: 172 }], ranges)).toEqual([{ after: 86, before: 172 }]);
  ranges = addChatReadRange(ranges, { from: 87, to: 171 });
  expect(chatReadGaps([{ createdSeq: 36 }, { createdSeq: 86 }, { createdSeq: 172 }], ranges)).toEqual([]);
});

it("does not label covered edit or deletion sequences or an unrequested prefix as internal gaps", () => {
  expect(chatReadGaps([{ createdSeq: 11 }, { createdSeq: 14 }, { createdSeq: 18 }], [{ from: 11, to: 20 }])).toEqual([]);
  expect(chatReadGaps([{ createdSeq: 72 }, { createdSeq: 121 }], [{ from: 72, to: 121 }])).toEqual([]);
});

it("keeps a way to fill a known gap when either fetched block has since been deleted", () => {
  const ranges = [{ from: 0, to: 36 }, { from: 172, to: 221 }];
  expect(chatReadGaps([{ createdSeq: 172 }], ranges)).toEqual([{ after: 36, before: 172 }]);
  expect(chatReadGaps([{ createdSeq: 36 }], ranges)).toEqual([{ after: 36, before: null }]);
  expect(chatReadGaps([], ranges)).toEqual([{ after: 36, before: null }]);
});
