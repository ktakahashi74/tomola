import type { Lang } from "./languages";

export type PassagePair = { source: string; translation: string };
export type TranslationTerms = {
  author: string[];
  response?: { title?: PassagePair; passages: PassagePair[]; author: string[] };
};
export const AUTHOR_TERMS_MAX = 8;
export const PASSAGES_MAX_CHARS = 3200;
export const TITLE_BODY_MAX_CHARS = 1500;
const cut = (text: string, chars: number) => Array.from(text).slice(0, chars).join("");
// Match backtick runs once, so unmatched delimiters cannot trigger repeated scans.
function withoutInlineCode(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  const next = new Map<number, number>(), closing = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length;
    if (next.has(length)) closing.set(i, next.get(length)!);
    next.set(length, i);
  }
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < runs.length; i++) {
    const end = closing.get(i);
    if (end === undefined) continue;
    out.push(text.slice(start, runs[i].index));
    start = runs[end].index + runs[end][0].length;
    i = end;
  }
  out.push(text.slice(start));
  return out.join("");
}

// These are conservative text excerpts, not a Markdown parse. Blank lines
// separate paragraphs; discard code, quotes (including lazy continuations),
// HTML and image paragraphs rather than guessing their contents or alignment.
function paragraphs(body: string): Array<{ text: string; kind: string }> {
  const out: Array<{ text: string; kind: string }> = [];
  let lines: string[] = [], excluded = false;
  let fence: { marker: string; length: number } | undefined;
  let htmlEnd: string | undefined;
  const flush = () => {
    const text = withoutInlineCode(lines.join("\n")).trim();
    if (!excluded && text) {
      const kind = /^ {0,3}#{1,6}(?:\s|$)/.test(text) ? "heading" : /^ {0,3}(?:[-+*]|\d+[.)])\s/.test(text) ? "list" : "paragraph";
      out.push({ text, kind });
    }
    lines = []; excluded = false;
  };
  for (const line of body.split(/\r?\n/)) {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (run && run[1][0] === fence.marker && run[1].length >= fence.length && !run[2].trim()) fence = undefined;
      continue;
    }
    if (htmlEnd) { if (line.toLowerCase().includes(htmlEnd)) htmlEnd = undefined; continue; }
    const rawHtml = /^ {0,3}(?:<(script|style|pre|textarea)(?:\s|>)|<!--)/i.exec(line);
    if (rawHtml) {
      flush();
      const end = rawHtml[1] ? `</${rawHtml[1].toLowerCase()}>` : "-->";
      if (!line.toLowerCase().includes(end)) htmlEnd = end;
      continue;
    }
    if (run) { flush(); fence = { marker: run[1][0], length: run[1].length }; continue; }
    if (!line.trim()) { flush(); continue; }
    if (/^(?: {4}|\t)|^ {0,3}(?:>|<|!\[|\[[^\]\n]+\]:)/.test(line) || line.includes("<") || line.includes("![")) excluded = true;
    lines.push(line);
  }
  flush();
  return out;
}
const names: Record<Lang, string> = {
  en: "英語|English", ja: "日本語|Japanese", fr: "フランス語|French", de: "ドイツ語|German",
  "zh-Hans": "簡体字中国語|中国語（簡体字）|Simplified Chinese", "zh-Hant": "繁体字中国語|中国語（繁体字）|Traditional Chinese",
  ko: "韓国語|Korean", th: "タイ語|Thai", vi: "ベトナム語|Vietnamese",
};

// Recognize explicit language-labelled declarations across the whole post. The
// translator resolves the term being named; these excerpts are data, not commands.
export function authorTermDeclarations(body: string, to: Lang): string[] {
  const marker = `(?:${names[to]})`;
  if (!new RegExp(marker, "iu").test(body)) return [];
  const pattern = new RegExp(`[^。！？\\n]{0,100}[（(](?:${marker}(?:では|で|[:：])\\s*|in\\s+${marker}\\s*[:：]\\s*)[^）)\\n]{1,120}[）)]`, "giu");
  const found: string[] = [];
  for (const paragraph of paragraphs(body)) {
    for (const match of paragraph.text.matchAll(pattern)) {
      if (!found.includes(match[0])) found.push(match[0]);
      if (found.length === AUTHOR_TERMS_MAX) return found;
    }
  }
  return found;
}

// Pair corresponding text paragraphs only when their coarse shapes agree. Select
// passages sharing words with the text being translated, including terms late
// in a long post. No extra model call or site-wide glossary entry is needed.
function rankedPassages(source: string, translation: string, subject: string): PassagePair[] {
  const a = paragraphs(source), b = paragraphs(translation);
  if (a.length !== b.length || a.some((n, i) => n.kind !== b[i].kind)) return [];
  const grams = (text: string) => {
    const chars = Array.from(text.toLocaleLowerCase());
    return new Set(chars.slice(2).map((_, i) => chars.slice(i, i + 3).join("")));
  };
  const wanted = grams(subject);
  return a.map((node, i) => {
    const text = node.text;
    const score = [...grams(text)].filter(g => wanted.has(g)).length;
    return { source: text, translation: b[i].text, score, i };
  }).filter(p => p.source && p.translation).sort((x, y) => y.score - x.score || x.i - y.i);
}

export function terminologyPassages(source: string, translation: string, subject: string, maxChars = PASSAGES_MAX_CHARS): PassagePair[] {
  const pairs = rankedPassages(source, translation, subject);
  const out: PassagePair[] = [];
  let remaining = maxChars;
  for (const pair of pairs.slice(0, 6)) {
    if (remaining < 40) break;
    const allowance = Math.min(remaining, 800);
    const source = cut(pair.source, Math.floor(allowance / 2));
    const translated = cut(pair.translation, allowance - Array.from(source).length);
    out.push({ source, translation: translated });
    remaining -= Array.from(source + translated).length;
  }
  return out;
}

// Preserve the full original prefix budget and give translated terms their own
// budget. JSON avoids prose labels that a short translated title could imitate.
export function titleBodyContext(source: string, translated: string | undefined, title: string): string {
  const prefix = cut(source, TITLE_BODY_MAX_CHARS);
  if (!translated) return prefix;
  const pairs = rankedPassages(source, translated, title).slice(0, 6);
  const translation = cut(pairs.length ? pairs.map(p => p.translation).join("\n\n") : translated, TITLE_BODY_MAX_CHARS);
  return JSON.stringify({ source: prefix, translation });
}
