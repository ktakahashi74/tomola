// Segment original bodies into `Intl.Segmenter` (ICU) sentences, always also splitting at paragraph newlines.
// Pure function: same input/output in browser/server, without DOM or DB dependencies.
// Sentence id `s-<idx>` via segmentId. start/end are JavaScript UTF-16 code-unit indices with exclusive end;
// text.slice(start,end) is the trimmed sentence body.
// Thai: ICU lacks sentence rules; Thai uses spaces for sentences/clauses instead of periods. For Thai lines/paragraphs
// without punctuation (. ! ? … 。 etc.) that ICU leaves as one sentence, also split on whitespace runs,
// via splitThaiAtSpaces. Punctuated lines retain ICU segmentation. Japanese/English split at punctuation.
// Segments are created on posting/edit and stored in segments; s-<idx> ids/positions refer to that source version. Rule changes
// do not affect existing posts until edited.

export type Segment = { idx: number; start: number; end: number; text: string };

export function segmentId(idx: number): string {
  return `s-${idx}`;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(lang: string): Intl.Segmenter {
  let segmenter = segmenters.get(lang);
  if (!segmenter) {
    let locale: string | undefined = lang;
    try {
      Intl.getCanonicalLocales(lang);
    } catch {
      locale = undefined;
    }
    segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
    segmenters.set(lang, segmenter);
  }
  return segmenter;
}

// Paragraph ranges: newline-separated runs. ICU also splits after newlines, but pre-split to avoid implementation differences.
function lineRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n" || text[i] === "\r") {
      if (i > start) ranges.push([start, i]);
      start = i + 1;
    }
  }
  return ranges;
}

const isSpace = (ch: string) => /\s/u.test(ch);

// Whether a line ends in sentence punctuation: ASCII/full-width periods, exclamation/question marks, ellipsis or Japanese period, optionally followed by closing quotes/brackets.
// ICU handles internal punctuation; single-sentence lines have no internal boundary. Ignore non-boundary periods such as those within URLs here.
const ENDS_WITH_TERMINATOR = /[.!?…。．！？‼⁇⁈⁉]["'”’)\]」』）】]*\s*$/u;

// Split unpunctuated Thai lines at whitespace: one non-whitespace run per sentence within [from,to). Runs without letters/digits, such as Markdown 「-」「*」「#」「>」
// markers, attach to the next sentence, or previous if last. A marker-only line is one sentence.
function splitThaiAtSpaces(text: string, from: number, to: number): Array<[number, number]> {
  const tokens: Array<[number, number]> = [];
  let start = -1;
  for (let i = from; i <= to; i++) {
    const space = i === to || isSpace(text[i]);
    if (!space && start < 0) start = i;
    if (space && start >= 0) {
      tokens.push([start, i]);
      start = -1;
    }
  }
  const out: Array<[number, number]> = [];
  let pending = -1;
  for (const [s, e] of tokens) {
    if (/[\p{L}\p{N}]/u.test(text.slice(s, e))) {
      out.push([pending >= 0 ? pending : s, e]);
      pending = -1;
    } else if (pending < 0) {
      pending = s;
    }
  }
  if (pending >= 0) {
    if (out.length > 0) out[out.length - 1][1] = tokens[tokens.length - 1][1];
    else out.push([pending, tokens[tokens.length - 1][1]]);
  }
  return out;
}

export function segmentSentences(text: string, lang: string): Segment[] {
  const segmenter = segmenterFor(lang);
  const out: Segment[] = [];
  const push = (start: number, end: number) => {
    while (start < end && isSpace(text[start])) start++;
    while (end > start && isSpace(text[end - 1])) end--;
    if (end > start) out.push({ idx: out.length, start, end, text: text.slice(start, end) });
  };
  for (const [from, to] of lineRanges(text)) {
    const parts = [...segmenter.segment(text.slice(from, to))];
    // For unpunctuated Thai lines ICU leaves as one sentence, also split on spaces.
    if (lang === "th" && parts.length === 1 && !ENDS_WITH_TERMINATOR.test(text.slice(from, to))) {
      for (const [start, end] of splitThaiAtSpaces(text, from, to)) push(start, end);
      continue;
    }
    for (const part of parts) push(from + part.index, from + part.index + part.segment.length);
  }
  return out;
}
