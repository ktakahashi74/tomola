export type ChatReadRange = { from: number; to: number };

// Sequence numbers also cover edits and deletions, so coverage comes from fetched pages.
export function addChatReadRange(ranges: ChatReadRange[], range: ChatReadRange | null): ChatReadRange[] {
  if (!range || range.from > range.to) return ranges;
  const merged: ChatReadRange[] = [];
  for (const next of [...ranges, range].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && next.from <= last.to + 1) last.to = Math.max(last.to, next.to);
    else merged.push({ ...next });
  }
  return merged;
}

export function chatReadThrough(readSeq: number, ranges: ChatReadRange[]): number {
  let end = readSeq;
  for (const range of ranges) {
    if (range.from > end + 1) break;
    end = Math.max(end, range.to);
  }
  return end;
}

export function chatSnapshotRange(page: {
  messages: { createdSeq: number }[]; before: number | null; seq: number; hasNewer: boolean; historical: boolean; readFrom?: number | null;
}): ChatReadRange | null {
  if (!page.messages.length) return page.historical ? null : { from: 0, to: page.seq };
  return {
    from: page.before === null ? 0 : Math.min(page.messages[0].createdSeq, page.readFrom ?? Infinity),
    to: page.hasNewer ? page.messages.at(-1)!.createdSeq : Math.max(page.seq, page.messages.at(-1)!.createdSeq),
  };
}

export function chatForwardRange(after: number, since: number, page: { messages: { createdSeq: number }[]; hasNewer: boolean }): ChatReadRange {
  const last = page.messages.at(-1)?.createdSeq ?? after;
  return { from: after + 1, to: page.hasNewer ? last : Math.max(last, since) };
}

export function chatReadGaps(messages: { createdSeq: number }[], ranges: ChatReadRange[]): { after: number; before: number | null }[] {
  const gaps: { after: number; before: number | null }[] = [];
  for (let i = 1; i < ranges.length; i++) {
    const after = ranges[i - 1].to;
    if (ranges[i].from <= after + 1) continue;
    const before = messages.find(message => message.createdSeq >= ranges[i].from)?.createdSeq ?? null;
    if (!gaps.some(gap => gap.before === before)) gaps.push({ after, before });
  }
  return gaps;
}
