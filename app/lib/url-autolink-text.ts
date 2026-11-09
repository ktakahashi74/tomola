// Preserve GFM's literal-text recognition in micromark events, before mdast is
// built. Balanced links/images and code keep their normal inline grammar.
// Matching/domain/trail rules adapted from mdast-util-gfm-autolink-literal 2.0.1;
/*
(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
import type { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import remarkParse from "remark-parse";
import { unified } from "unified";

type Extension = ReturnType<typeof gfmAutolinkLiteral>;
type Construct = Exclude<NonNullable<NonNullable<Extension["text"]>[number]>, unknown[]>;
type Context = ThisParameterType<Construct["tokenize"]>;
type Event = Context["events"][number];
type Token = Event[1];
type Point = Token["start"];

// Only a bounded single reference is decoded here, never a URL or its suffix.
// Native CommonMark handles the complete named/numeric character-reference set.
const references = new Map<string, string>();
const referenceParser = unified().use(remarkParse);
function decodeReference(raw: string): string {
  const saved = references.get(raw);
  if (saved !== undefined) return saved;
  const tree = referenceParser.parse(raw);
  const paragraph = tree.children[0];
  const text = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
  const value = text?.type === "text" ? text.value : raw;
  if (references.size >= 128) references.clear();
  references.set(raw, value);
  return value;
}

const protectedTypes = new Set(["link", "image", "autolink", "literalAutolink", "codeText", "htmlText", "mathText"]);
const plainTypes = new Set(["data", "characterEscape", "characterReference"]);
const punctuation = /[\p{P}\p{S}\s]/u;
const urlPrefix = /https?:\/\/|www(?=\.)/gi;
const domainRun = /[-.\w]+/y;
const urlBoundary = /[ \t\r\n。、，．：；！？・…‥「」『』（）［］【】〈〉《》〔〕｛｝〜‘’“”]/g;
// Advance through each local/domain run once, including unsuccessful emails.
// A regex that retries at every dot in a punctuation run is quadratic.
function emails(value: string): Array<{ index: number; end: number }> {
  const matches: Array<{ index: number; end: number }> = [];
  const local = (char: string) => /[-.\w+]/.test(char);
  const label = (char: string) => /[-\w]/.test(char);
  let index = 0;
  while (index < value.length) {
    if (!local(value[index])) { index++; continue; }
    let start = index;
    while (index < value.length && local(value[index])) index++;
    if (value[index] !== "@") continue;
    // A rejected local part can still contain a later valid start, such as
    // c.d@e.com after '/'. Reuse its domain instead of rescanning the suffix.
    while (start < index && start && (value[start - 1] === "/" || !/[\p{P}\p{S}\s]$/u.test(value.slice(Math.max(0, start - 2), start)))) start++;
    if (start === index) { index++; continue; }
    let cursor = index + 1, segments = 0, end = cursor;
    while (cursor < value.length && label(value[cursor])) {
      while (cursor < value.length && label(value[cursor])) cursor++;
      segments++; end = cursor;
      if (value[cursor] !== "." || !value[cursor + 1] || !label(value[cursor + 1])) break;
      cursor++;
    }
    if (segments > 1 && !/[-\d_]/.test(value[end - 1])) {
      matches.push({ index: start, end }); index = end;
    } else index++;
  }
  return matches;
}

const validDomainPart = (value: string) => !value || (!value.includes("_") && /[a-zA-Z0-9]/.test(value));
function trimUrl(value: string): string {
  const tail = /[!"&'),.:;<>?\]}]+$/.exec(value);
  if (!tail) return value;
  let end = tail.index;
  let balance = 0;
  for (let i = 0; i < end; i++) balance += value[i] === "(" ? 1 : value[i] === ")" ? -1 : 0;
  for (let i = end; i < value.length && balance > 0; i++) if (value[i] === ")") { end = i + 1; balance--; }
  return value.slice(0, end);
}

type SourceChunk = { offset: number; point: Point };
type Segment = { raw: string; value: string; events: Event[]; start: number; end: number; chunks?: SourceChunk[] };

// Adjacent data events may have been coalesced across physical tab chunks.
// Record chunk boundaries once, then locate split points without replaying the
// whole token for each URL. Columns/offsets follow micromark's consume rules:
// a tab consumes one source character; its virtual padding consumes none.
function sourceChunks(token: Token, context: Context): SourceChunk[] {
  const result: SourceChunk[] = [];
  const point = { ...token.start };
  let offset = 0, atTab = false;
  for (const chunk of context.sliceStream(token)) {
    if (typeof chunk === "string") {
      if (point._bufferIndex < 0) point._bufferIndex = 0;
      result.push({ offset, point: { ...point } });
      offset += chunk.length; point.offset += chunk.length; point.column += chunk.length;
    } else {
      result.push({ offset, point: { ...point } });
      if (chunk === -1) {
        if (!atTab) offset++;
      } else if (chunk === -3 || chunk === -4 || chunk === -5) {
        const length = chunk === -3 ? 2 : 1;
        offset += length; point.offset += length; point.line++; point.column = 1;
      } else {
        offset++; point.offset++; point.column++;
      }
    }
    point._index++; point._bufferIndex = -1;
    if (chunk !== -1 || !atTab) atTab = chunk === -2;
  }
  return result;
}
function resolveText(events: Event[], context: Context): Event[] {
  const originalEvents = events;
  const finalized = new Set<Construct["resolveAll"]>();
  for (const registered of [context.parser.constructs.insideSpan.null, context.parser.constructs.text[93]]) {
    for (const construct of Array.isArray(registered) ? registered : registered ? [registered] : []) {
      const resolve = construct.resolveAll;
      if (resolve && resolve !== resolveText && !finalized.has(resolve)) {
        events = resolve(events, context);
        finalized.add(resolve);
      }
    }
  }
  const output: Event[] = [];
  let group: Segment[] = [];
  let depth = 0;
  let rawSize = 0;
  const flush = () => {
    if (!group.length) return;
    let value = "";
    // Each decoded boundary maps back to the original token boundaries.
    const offsets: Array<number | undefined> = [0];
    for (const segment of group) {
      const base = value.length;
      value += segment.value;
      if (segment.events[0][1].type === "data") {
        for (let i = 0; i <= segment.value.length; i++) offsets[base + i] = segment.start + i;
      } else {
        offsets[base] = segment.start;
        offsets[base + segment.value.length] = segment.end;
      }
    }
    const rawText = group.map(segment => segment.raw).join("");
    type Match = { start: number; end: number; www: boolean; mail: boolean; decodedStart: number; decodedEnd: number };
    const urls: Match[] = [];
    // Search prefixes independently: rejecting one candidate must not consume
    // a later URL in the same whitespace-free run. Cache shared domain/path
    // ends so repeated rejected www prefixes cannot cause quadratic scans.
    let domainEnd = -1, lastDot = -1, beforeLastDot = -1, lastPartValid = false, beforeLastPartValid = false, pathEnd = -1;
    urlPrefix.lastIndex = 0;
    for (let match; (match = urlPrefix.exec(value));) {
      const start = match.index;
      const rawStart = offsets[start];
      const encodedPrefix = rawStart !== undefined && /^(?:https?|www)(?:\\|&)/i.test(rawText.slice(rawStart, rawStart + 16));
      if (start && !punctuation.test(value[start - 1]) && !(value.charCodeAt(start - 1) > 127 && encodedPrefix)) continue;
      const www = /^w/i.test(match[0]);
      const domainStart = www ? start : urlPrefix.lastIndex;
      // The www prefix still requires at least one following domain character.
      if (!/[-.\w]/.test(value[urlPrefix.lastIndex] ?? "")) continue;
      if (domainStart >= domainEnd) {
        domainRun.lastIndex = domainStart;
        const domain = domainRun.exec(value)!;
        domainEnd = domainRun.lastIndex;
        const dot = domain[0].lastIndexOf(".");
        lastDot = domainStart + dot;
        beforeLastDot = domainStart + (dot > 0 ? domain[0].lastIndexOf(".", dot - 1) : -1);
        lastPartValid = validDomainPart(value.slice(lastDot + 1, domainEnd));
        beforeLastPartValid = validDomainPart(value.slice(Math.max(domainStart, beforeLastDot + 1), lastDot));
      }
      if (lastDot < domainStart || !lastPartValid || !(domainStart <= beforeLastDot + 1 ? beforeLastPartValid : validDomainPart(value.slice(domainStart, lastDot)))) continue;
      if (domainEnd >= pathEnd) {
        urlBoundary.lastIndex = domainEnd;
        pathEnd = urlBoundary.exec(value)?.index ?? value.length;
      }
      const length = trimUrl(value.slice(start, pathEnd)).length;
      if (length <= (www ? 0 : match[0].length)) continue;
      const a = offsets[start], b = offsets[start + length];
      if (a !== undefined && b !== undefined && b > a) {
        urls.push({ start: a, end: b, www, mail: false, decodedStart: start, decodedEnd: start + length });
        urlPrefix.lastIndex = pathEnd;
      }
    }
    // GFM recognizes URLs first, then emails only in the remaining text. An
    // email that starts earlier must not swallow a later accepted www URL.
    const matches: Match[] = [];
    let decodedCursor = 0;
    const addEmails = (end: number) => {
      for (const match of emails(value.slice(decodedCursor, end))) {
        const decodedStart = decodedCursor + match.index, decodedEnd = decodedCursor + match.end;
        const a = offsets[decodedStart], b = offsets[decodedEnd];
        if (a !== undefined && b !== undefined && b > a) matches.push({ start: a, end: b, www: false, mail: true, decodedStart, decodedEnd });
      }
    };
    for (const match of urls) {
      addEmails(match.decodedStart);
      matches.push(match); decodedCursor = match.decodedEnd;
    }
    addEmails(value.length);
    let segmentIndex = 0;
    let cursor = 0;
    const point = (offset: number): Point => {
      // Called in source order, apart from the two ends of one URL.
      let index = segmentIndex;
      while (index < group.length - 1 && offset > group[index].end) index++;
      const segment = group[index];
      const token = segment.events[0][1];
      if (offset === segment.start) return { ...token.start };
      if (offset === segment.end) return { ...segment.events.at(-1)![1].end };
      const chunks = segment.chunks ??= sourceChunks(token, context);
      const within = offset - segment.start;
      let low = 0, high = chunks.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (chunks[middle].offset <= within) low = middle + 1; else high = middle;
      }
      const chunk = chunks[low - 1], delta = within - chunk.offset;
      return { ...chunk.point, column: chunk.point.column + delta, offset: chunk.point.offset + delta, _bufferIndex: chunk.point._bufferIndex + delta };
    };
    const emit = (end: number) => {
      while (cursor < end) {
        const segment = group[segmentIndex];
        const next = Math.min(end, segment.end);
        if (cursor === segment.start && next === segment.end) output.push(...segment.events);
        else {
          const token: Token = { ...segment.events[0][1], start: point(cursor), end: point(next) };
          output.push(["enter", token, context], ["exit", token, context]);
        }
        cursor = next;
        if (cursor === segment.end) segmentIndex++;
      }
    };
    for (const match of matches) {
      if (match.start < cursor) continue;
      emit(match.start);
      const literal: Token = { type: "literalAutolink", start: point(match.start), end: point(match.end) };
      const token: Token & { _urlDecoded?: boolean } = { ...literal, type: match.mail ? "literalAutolinkEmail" : match.www ? "literalAutolinkWww" : "literalAutolinkHttp", _urlDecoded: true };
      output.push(["enter", literal, context], ["enter", token, context]);
      emit(match.end);
      output.push(["exit", token, context], ["exit", literal, context]);
    }
    emit(rawSize);
    group = []; rawSize = 0;
  };
  for (let index = 0; index < events.length; index++) {
    const event = events[index], token = event[1];
    if (protectedTypes.has(token.type)) {
      flush();
      if (event[0] === "enter") depth++; else depth--;
      output.push(event); continue;
    }
    if (!depth && event[0] === "enter" && plainTypes.has(token.type)) {
      let end = index + 1;
      while (end < events.length && !(events[end][0] === "exit" && events[end][1] === token)) end++;
      const raw = context.sliceSerialize(token);
      const value = token.type === "characterEscape" ? raw.slice(1) : token.type === "characterReference" ? decodeReference(raw) : raw;
      group.push({ raw, value, events: events.slice(index, end + 1), start: rawSize, end: rawSize + raw.length });
      rawSize += raw.length; index = end;
    } else { flush(); output.push(event); }
  }
  flush();
  originalEvents.length = output.length;
  for (let index = 0; index < output.length; index++) originalEvents[index] = output[index];
  return originalEvents;
}

// Register on source constructs even when native autolinks decline a candidate
// (for example, inside an unmatched '['). Forwarding retains the core label,
// escape and reference rules, including links that resolve later in the line.
export function urlTextAutolinks(): Extension {
  const text: NonNullable<Extension["text"]> = {};
  for (const code of [91, 92, 38]) {
    const construct: Construct = {
      resolveAll: resolveText,
      tokenize(effects, ok, nok) {
        const registered = this.parser.constructs.text[code];
        const others = (Array.isArray(registered) ? registered : registered ? [registered] : []).filter(candidate => candidate !== construct);
        return effects.attempt(others, ok, nok);
      },
    };
    text[code] = construct;
  }
  const literal: Construct = {
    add: "after", resolveAll: resolveText,
    previous: code => code === null || (code < 0 || punctuation.test(String.fromCharCode(code))),
    tokenize(effects, ok) { return code => { effects.enter("data"); effects.consume(code); effects.exit("data"); return ok; }; },
  };
  for (const code of [72, 104, 87, 119]) text[code] = literal;
  // Native email recognition can decline before reaching '@', for example
  // after a slash or an opening underscore. Finalize that remaining text too.
  text[64] = { ...literal, previous: undefined };
  return { text };
}
