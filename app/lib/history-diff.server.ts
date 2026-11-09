export type HistoryChange = { kind: "same" | "added" | "removed"; text: string };

// Sentence units retain every byte of the original, including paragraph breaks.
const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const units = (text: string) => [...segmenter.segment(text)].map(s => s.segment);

export function historyDiff(before: string, after: string): HistoryChange[] {
  const a = units(before), b = units(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const changes: HistoryChange[] = [];
  const add = (kind: HistoryChange["kind"], text: string) => {
    if (!text) return;
    const last = changes.at(-1);
    if (last?.kind === kind) last.text += text;
    else changes.push({ kind, text });
  };
  add("same", a.slice(0, start).join(""));
  const n = endA - start, m = endB - start;
  // Bound work for very long or adversarial posts. The changed middle remains
  // complete; only matching within that middle is omitted above this limit.
  if (n * m > 250_000) {
    add("removed", a.slice(start, endA).join(""));
    add("added", b.slice(start, endB).join(""));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[start + i] === b[start + j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { add("same", a[start + i++]); j++; }
      else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) add("removed", a[start + i++]);
      else add("added", b[start + j++]);
    }
  }
  add("same", a.slice(endA).join(""));
  return changes;
}
