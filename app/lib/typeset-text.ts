import { mentionCandidates } from "./mention-syntax";

const WESTERN = new Set(["en", "fr", "de", "es", "pt", "id", "vi", "ru"]);
const QUOTES: Record<string, readonly [string, string]> = { en: ["“", "”"], de: ["„", "“"], fr: ["«", "»"] };
const FULLWIDTH: Record<string, string> = { "(": "（", ")": "）", ":": "：", ";": "；", "!": "！", "?": "？" };
const letter = (s: string) => /\p{L}/u.test(s);
const cjk = (s: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff60]/u.test(s);
const asciiWord = (s: string) => /[A-Za-z0-9_]/.test(s);
const space = (s: string) => s === " " || s === "\u00a0" || s === "\u202f";
export const isCjkTypesetting = (lang: string | undefined) => lang === "ja" || lang === "zh-Hans" || lang === "zh-Hant";

function before(text: string, i: number): string {
  if (i <= 0) return "";
  const low = text.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff && i > 1 ? text.slice(i - 2, i) : text[i - 1];
}
const at = (text: string, i: number): string => i >= text.length ? "" : String.fromCodePoint(text.codePointAt(i)!);

// Validate the whole paragraph before replacing any quote. Uncertain nesting,
// measurements and space-padded quotes keep their straight quotation marks.
function pairedQuotes(text: string, mask: Uint8Array): boolean {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (mask[i] || text[i] !== '"') continue;
    const prev = before(text, i), next = at(text, i + 1);
    if (count % 2 === 0) {
      if ((prev !== "" && !/[\s\p{Ps}\p{Pi}]/u.test(prev)) || next === "" || /[\s"]/u.test(next)) return false;
    } else {
      if (prev === "" || /[\s"]/u.test(prev) || (next !== "" && !/[\s\p{Pe}\p{Pf}.,:;!?…]/u.test(next))) return false;
    }
    count++;
  }
  return count % 2 === 0;
}

// A fixed-prefix scan, not a URL parser. Ambiguous URL-like runs remain untouched.
// The mask also protects unresolved mentions and literal inline-code/math notation in titles.
export function typesetProtectedText(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const mention of mentionCandidates(text)) mask.fill(1, mention.start, mention.end);
  for (let i = 0; i < text.length;) {
    let url = ["https://", "http://", "ftp://", "mailto:", "www."].some(prefix => text.slice(i, i + prefix.length).toLowerCase() === prefix);
    if (!url && /[A-Za-z]/.test(text[i])) {
      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9+.-]/.test(text[end])) end++;
      url = text.startsWith("://", end);
      if (!url) { i = end; continue; }
    }
    if (url) {
      const start = i;
      while (i < text.length && !/[\s<>"«»「」『』（）]/u.test(at(text, i))) i += at(text, i).length;
      mask.fill(1, start, i);
    } else i++;
  }
  for (let i = 0; i < text.length;) {
    if (text[i] === "`" || text[i] === "$") {
      const start = i++;
      while (i < text.length && text[i] !== text[start] && text[i] !== "\n") i++;
      if (text[i] === text[start]) mask.fill(1, start, ++i);
    } else i++;
  }
  return mask;
}

// One replacement per UTF-16 position keeps changes in their original text nodes.
// Each scan visits every position a bounded number of times, including whitespace and parentheses.
export function typesetCharacters(text: string, lang: string, mask = typesetProtectedText(text)): string[] {
  const out = text.split("");
  const western = WESTERN.has(lang);
  const quotes = QUOTES[lang];
  const convertQuotes = quotes !== undefined && pairedQuotes(text, mask);
  let opening = true;
  const widened = new Uint8Array(text.length);
  if (isCjkTypesetting(lang)) {
    const partners = new Int32Array(text.length).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (mask[i]) continue;
      if (text[i] === "\0") { stack.length = 0; continue; }
      if (text[i] === "(") stack.push(i);
      if (text[i] === ")" && stack.length) {
        const start = stack.pop()!;
        partners[start] = i; partners[i] = start;
      }
    }
    const effective = (i: number) => widened[i] ? FULLWIDTH[text[i]] : at(text, i);
    const effectiveBefore = (i: number) => widened[i - 1] ? FULLWIDTH[text[i - 1]] : before(text, i);
    const queue: number[] = [];
    const mark = (i: number) => { if (!widened[i]) { widened[i] = 1; queue.push(i); } };
    const consider = (i: number) => {
      if (i < 0 || i >= text.length || mask[i] || widened[i] || !FULLWIDTH[text[i]]) return;
      if (text[i] === "(" || text[i] === ")") {
        const other = partners[i];
        if (other < 0) return;
        const start = Math.min(i, other), end = Math.max(i, other);
        if (/[A-Za-z0-9]/.test(before(text, start))) return;
        const left = effectiveBefore(start), right = effective(end + 1);
        if (cjk(left) || cjk(right) || (!asciiWord(left) && !asciiWord(right) && (cjk(effective(start + 1)) || cjk(effectiveBefore(end))))) {
          mark(start); mark(end);
        }
      } else if (cjk(effectiveBefore(i)) || cjk(effective(i + 1))) mark(i);
    };
    for (let i = 0; i < text.length; i++) consider(i);
    // Propagate through adjacent punctuation and nested bracket pairs once, so a second pass changes nothing.
    for (let head = 0; head < queue.length; head++) { consider(queue[head] - 1); consider(queue[head] + 1); }
  }
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    const ch = text[i], prev = before(text, i), next = at(text, i + 1);
    if (western && ch === "'" && letter(prev) && letter(next) && !mask[i - 1] && !mask[i + 1]) out[i] = "’";
    if (western && text.startsWith("...", i) && !mask[i + 1] && !mask[i + 2]) {
      out[i] = "…"; out[i + 1] = out[i + 2] = ""; i += 2; continue;
    }
    if (quotes && convertQuotes && ch === '"') { out[i] = quotes[opening ? 0 : 1]; opening = !opening; }
    if (widened[i]) out[i] = FULLWIDTH[ch];
  }
  if (lang === "fr") {
    // Work on the replacements so newly generated guillemets receive the same spacing.
    let previous = -1;
    let gapStart = 0;
    for (let i = 0; i < text.length; i++) {
      if (mask[i] || text[i] === "\0") {
        if (previous >= 0 && out[previous] === "«\u00a0") for (let j = gapStart; j < i; j++) out[j] = "";
        previous = -1; gapStart = i + 1; continue;
      }
      if (space(out[i]) || out[i] === "") continue;
      const ch = out[i];
      const previousOutput = previous < 0 ? "" : out[previous];
      const left = before(previousOutput, previousOutput.length);
      const next = at(text, i + 1);
      const endsProse = next === "" || /[\s\p{Pe}\p{Pf}"']/u.test(next);
      if ((ch === ":" || ch === ";" || ch === "!" || ch === "?") && endsProse && (letter(left) || /\p{N}/u.test(left) || left === "»") && !(ch === ":" && /\p{N}/u.test(left) && /\p{N}/u.test(next))) {
        for (let j = gapStart; j < i; j++) out[j] = "";
        out[i] = (ch === ":" ? "\u00a0" : "\u202f") + ch;
      }
      if (ch === "»") {
        for (let j = gapStart; j < i; j++) out[j] = "";
        out[i] = "\u00a0»";
      }
      if (previousOutput === "«\u00a0") for (let j = gapStart; j < i; j++) out[j] = "";
      if (ch === "«") out[i] = "«\u00a0";
      previous = i;
      gapStart = i + 1;
    }
    if (previous >= 0 && out[previous] === "«\u00a0") for (let j = gapStart; j < text.length; j++) out[j] = "";
  }
  return out;
}

// Only short, plain translated titles use this on the request thread.
export function typesetText(text: string, lang: string): string {
  return typesetCharacters(text, lang).join("");
}

export function englishWordParts(text: string, left = "", right = ""): Array<string | { word: string }> {
  const mask = typesetProtectedText(text);
  const parts: Array<string | { word: string }> = [];
  let copied = 0;
  const identifier = (s: string) => /[0-9_\p{Script=Latin}\p{M}]/u.test(s);
  const latin = (s: string) => /\p{Script=Latin}/u.test(s) && !/[\uff21-\uff3a\uff41-\uff5a]/u.test(s);
  for (let i = 0; i < text.length;) {
    if (mask[i] || !latin(at(text, i))) { i += at(text, i).length; continue; }
    const start = i;
    let letters = 0;
    while (i < text.length && !mask[i]) {
      const ch = at(text, i);
      if (latin(ch)) letters++;
      else if (!/\p{M}/u.test(ch)) break;
      i += ch.length;
    }
    if (letters < 8 || identifier(start === 0 ? left : before(text, start)) || identifier(i === text.length ? right : at(text, i))) continue;
    if (copied < start) parts.push(text.slice(copied, start));
    parts.push({ word: text.slice(start, i) });
    copied = i;
  }
  if (copied < text.length) parts.push(text.slice(copied));
  return parts;
}
