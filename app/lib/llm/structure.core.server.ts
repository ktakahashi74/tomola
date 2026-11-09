import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";
import { FLAG_LINK_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH } from "./flags";
import { chatParts } from "../village-chat";

// Translation structure checks: compare code-block counts and parsed math, and ensure fenced/inline code contents are character-for-character identical in the same order,
// including comments/docstrings; require translation absolute-link URLs and image src values to be a subset of
// the original. Ignore anchors (#見出し) and relative link paths.
// Cheap detection of omitted/added code or math, translated code content, and changed/added links; does not validate semantic correctness.

// Prose only: remove code, math and URLs. Language detection additionally omits
// quoted speech, including lazy continuations; translation checks still inspect it.
export function proseOf(md: string, excludeQuotes = false): string {
  const normalized = md.replace(/\r\n/g, "\n");
  const withoutCode = stripInlineCode(stripFencedCode(excludeQuotes ? stripNodes(normalized, "blockquote") : normalized).rest);
  return stripNodes(stripNodes(withoutCode, "math"), "inlineMath")
    // URLs extend through consecutive ASCII characters only; do not absorb unspaced Japanese or Chinese text immediately following the URL.
    .replace(/https?:\/\/[^\s\u0080-\uffff]+|www\.[^\s\u0080-\uffff]+/g, "");
}

export type StructureCounts = {
  codeBlocks: number;
  // Parsed math nodes, matching the renderer; literal currency dollars are not delimiters.
  displayMath: number;
  inlineMath: number;
};

const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})(.*)$/;

// Remove fenced code blocks, returning their count and remaining prose. An unclosed fence makes the rest code.
function stripFencedCode(md: string): { rest: string; blocks: number } {
  const lines = md.split("\n");
  const kept: string[] = [];
  let blocks = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // Backtick-fence info strings cannot contain backticks; otherwise this is inline code.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      blocks++;
      continue;
    }
    kept.push(line);
  }
  return { rest: kept.join("\n"), blocks };
}

export function countStructure(md: string): StructureCounts {
  const source = md.replace(/\r\n/g, "\n");
  const { blocks } = stripFencedCode(source);
  let displayMath = 0, inlineMath = 0;
  const walk = (node: MdNode) => {
    if (node.type === "math") displayMath++;
    else if (node.type === "inlineMath") inlineMath++;
    node.children?.forEach(walk);
  };
  walk(markdown.parse(source) as unknown as MdNode);
  return { codeBlocks: blocks, displayMath, inlineMath };
}

const markdown = createMarkdownProcessor();

type MdNode = {
  type: string;
  url?: string | null;
  identifier?: string;
  // Contents of code/inlineCode. lang/meta are the fence info string: python and title="x" in ```python title="x".
  value?: string;
  lang?: string | null;
  meta?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};

// A translation must not introduce math when the source contains none. Escape
// literal dollars before inspection and storage, preserving every code span.
export function normalizeTranslationDollars(source: string, translated: string): string {
  if (!translated.includes("$")) return translated;
  const math = countStructure(source);
  if (math.displayMath || math.inlineMath) return translated;
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const walk = (node: MdNode) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (node.type === "code" || node.type === "inlineCode") {
      if (start !== undefined && end !== undefined) spans.push({ start, end, text: translated.slice(start, end) });
      return;
    }
    if (node.type === "link" && start !== undefined && end !== undefined) {
      const raw = translated.slice(start, end);
      if (!raw.startsWith("[") && raw.includes("$")) {
        const angle = raw.startsWith("<"), label = angle ? raw.slice(1, -1) : trimBareUrl(raw);
        const link = (markdown.parse(angle ? raw : label) as unknown as MdNode).children?.[0]?.children?.find(child => child.type === "link");
        if (link?.url) {
          // Backslash dollars in bare/autolink URLs would change the address.
          // Explicit Markdown destinations decode those escapes, preserving it.
          const escapedLabel = label.replace(/[\\[\]$]/g, "\\$&");
          const escapedUrl = link.url.replace(/[\\<>$]/g, "\\$&");
          spans.push({ start, end: angle ? end : start + label.length, text: `[${escapedLabel}](<${escapedUrl}>)` });
          return;
        }
      }
    }
    node.children?.forEach(walk);
  };
  // Mask dollars at the same offsets so accidental math cannot swallow inline
  // code that occurs between two amounts. Code syntax itself stays unchanged.
  walk(markdown.parse(translated.replace(/\$/g, "x")) as unknown as MdNode);
  const out: string[] = [];
  let nextSpan = 0, backslashes = 0;
  for (let i = 0; i < translated.length; i++) {
    if (spans[nextSpan]?.start === i) {
      out.push(spans[nextSpan].text);
      i = spans[nextSpan++].end - 1;
      backslashes = 0;
      continue;
    }
    const char = translated[i];
    if (char === "$" && backslashes % 2 === 0) out.push("\\");
    out.push(char);
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  return out.join("");
}

// Use Markdown positions rather than a backtracking delimiter regex. Unmatched
// backtick runs in a member's post must not block the web/worker event loop.
function stripInlineCode(source: string): string {
  return stripNodes(source, "inlineCode");
}

function stripNodes(source: string, type: string): string {
  const parts: string[] = [];
  let cursor = 0;
  const walk = (node: MdNode) => {
    if (node.type === type) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        parts.push(source.slice(cursor, start));
        cursor = end;
      }
    } else node.children?.forEach(walk);
  };
  walk(markdown.parse(source) as unknown as MdNode);
  parts.push(source.slice(cursor));
  return parts.join("");
}

// URL with scheme (http, https, mailto, javascript, etc.) or scheme-relative `//host/path`.
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// Normalize for comparison: parse into href when possible (lowercase scheme/host, omit default port), remove fragments (#…),
// lowercase everything and remove the trailing /. Ignore capitalization, trailing slash and translated-fragment differences.
function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    url = parsed.href;
  } catch {
    // Leave values that cannot be parsed as URLs unchanged, such as relative image destinations.
  }
  return url.toLowerCase().replace(/\/+$/, "");
}

// GFM bare autolinks (neither `[…](…)` nor `<…>`) absorb Japanese/Chinese characters and full-width punctuation such as `を参照。` or `）`.
// Before comparing, truncate before the first non-ASCII character (full-width punctuation, CJK, Thai, etc.), identically for source and translation.
// Explicit destinations (`[x](https://例え.jp/a)`, `<https://…>`) have clear boundaries and are not truncated.
const NON_ASCII_TAIL = /[^\x00-\x7f][\s\S]*$/;

// After truncation, strip trailing ASCII punctuation and closing `)` without a matching `(` (`)` in `(https://…)を参照`), matching GFM treatment of ASCII prose.
export function trimBareUrl(raw: string, visit?: () => void): string {
  let url = raw.replace(NON_ASCII_TAIL, "");
  let balance = 0;
  for (const char of url) {
    visit?.();
    if (char === ")") balance++;
    else if (char === "(") balance--;
  }
  let end = url.length;
  while (end > 0) {
    visit?.();
    const last = url[end - 1];
    if (".,:;!?*_~'\"".includes(last)) end--;
    else if (last === ")" && balance > 0) { end--; balance--; }
    else break;
  }
  return url.slice(0, end);
}

// Destinations to compare in Markdown: scheme-bearing absolute URLs from links, reference definitions and autolinks (including bare URLs such as `www.`),
// plus image src values, whether absolute or relative. Pure `#見出し` anchors and relative link paths may harmlessly change during heading translation,
// so ignore them. Ignore code content too.
export function extractLinks(md: string): Set<string> {
  const out = new Set<string>();
  const source = md.replace(/\r\n/g, "\n");
  const tree = markdown.parse(source) as unknown as MdNode;
  const definitions = new Map<string, string>();
  const collect = (node: MdNode): void => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node.url);
    node.children?.forEach(collect);
  };
  collect(tree);
  const walk = (node: MdNode) => {
    if (node.type === "imageReference" && node.identifier) {
      const target = definitions.get(node.identifier.toUpperCase());
      if (target?.trim()) out.add(normalizeUrl(target));
    }
    if (node.url) {
      let url = node.url;
      if (node.type === "link") {
        const first = node.position?.start.offset === undefined ? "" : source[node.position.start.offset];
        // Bare URLs (not starting with [ or <) truncate before non-ASCII characters.
        if (first !== "[" && first !== "<") url = trimBareUrl(url);
      }
      if (node.type === "image" || ((node.type === "link" || node.type === "definition") && ABSOLUTE_URL.test(url.trim()))) {
        if (url.trim() !== "") out.add(normalizeUrl(url));
      }
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

export type CodeContent = {
  // Per fenced code block: the info string and the content (what Markdown makes of it: without the fences and the indentation of the fence).
  fenced: string[];
  // Per inline code span: the content.
  inline: string[];
};

// Invisible differences in a fenced block do not count: trailing whitespace on a line and trailing blank lines (models strip them, and a renderer does not show them).
const normalizeBlock = (value: string) =>
  value
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");

// Collect the code content, in document order, from the Markdown syntax tree. An indented code block (no fence) is not collected: its edge against the
// surrounding text moves with the indentation.
export function extractCode(md: string): CodeContent {
  const source = md.replace(/\r\n/g, "\n");
  const out: CodeContent = { fenced: [], inline: [] };
  const walk = (node: MdNode) => {
    if (node.type === "code") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const raw = start === undefined ? "" : source.slice(start, end);
      if (/^\s*(?:`{3,}|~{3,})/.test(raw)) out.fenced.push(`${[node.lang ?? "", node.meta ?? ""].join(" ").trim()}\n${normalizeBlock(node.value ?? "")}`);
    } else if (node.type === "inlineCode") {
      out.inline.push(node.value ?? "");
    }
    node.children?.forEach(walk);
  };
  walk(markdown.parse(source) as unknown as MdNode);
  return out;
}

// Positions (1-based, in source order) of the source's code spans that the translation does not have, comparing as a multiset: inline code may move when the word order
// of the target language asks for it ("Pass `--seed` to `translations:compare`" becomes "`translations:compare` に `--seed` を渡す"), but every span must be there,
// unchanged, as many times as in the source. The spans themselves are not quoted: the result goes into a prompt note, and the source is untrusted text.
function missingInline(source: readonly string[], translated: readonly string[]): number[] {
  const available = new Map<string, number>();
  for (const code of translated) available.set(code, (available.get(code) ?? 0) + 1);
  const missing: number[] = [];
  source.forEach((code, i) => {
    const left = available.get(code) ?? 0;
    if (left > 0) available.set(code, left - 1);
    else missing.push(i + 1);
  });
  return missing;
}

// Does the translation have the same code as the source? Returns what differs (empty: nothing). Fenced blocks are compared in order, one by one (a block
// moved or swapped is a change); inline code is compared as a multiset. A different count and a changed content are different messages, so the retry note can
// say which. skipFenced: the fenced blocks are not compared (their count differs, which is reported on its own; comparing blocks that do not line up means nothing).
export function codeContentMismatches(source: string, translated: string, opts: { skipFenced?: boolean } = {}): string[] {
  return checkCodeContent(source, translated, opts).mismatches;
}

function checkCodeContent(source: string, translated: string, opts: { skipFenced?: boolean }) {
  const a = extractCode(source);
  const b = extractCode(translated);
  const out: string[] = [];
  let countMismatch = false, contentChanged = false;
  if (!opts.skipFenced) {
    if (a.fenced.length !== b.fenced.length) { countMismatch = true; out.push(`code block count differs: ${a.fenced.length} -> ${b.fenced.length}`); }
    else {
      const changed = a.fenced.flatMap((value, i) => (value === b.fenced[i] ? [] : [i + 1]));
      if (changed.length > 0) { contentChanged = true; out.push(`code block content changed (#${changed.join(", #")}): copy code exactly, comments and strings inside it included`); }
    }
  }
  if (a.inline.length !== b.inline.length) { countMismatch = true; out.push(`inline code count differs: ${a.inline.length} -> ${b.inline.length}: keep every inline code span of the source, and add none`); }
  else {
    const missing = missingInline(a.inline, b.inline);
    if (missing.length > 0) { contentChanged = true; out.push(`inline code content changed (source span #${missing.join(", #")} is not in the translation as written): copy inline code exactly; it may move to fit the word order`); }
  }
  return { mismatches: out, countMismatch, contentChanged };
}

// Wide bounds catch gross omissions/inventions, not translation style. Short
// prose and code/math-only posts are exempt from the length heuristic.
export const TRANSLATION_QUALITY_LIMITS = {
  minProseChars: 160,
  ratios: { compactToSpaced: [0.35, 5], spacedToCompact: [0.12, 2.5], other: [0.2, 4.5] },
  paragraphToleranceFrom: 6,
  paragraphTolerance: 1,
} as const;

function qualityParts(source: string) {
  let tree = markdown.parse(source) as unknown as MdNode;
  // Normalize list markers only in prose text nodes. Never rewrite code, math,
  // HTML or inline markup while deciding whether a middle dot starts a list.
  const markers: number[] = [];
  const collect = (node: MdNode) => {
    if (node.type === "text") {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const raw = source.slice(start, end);
        for (const match of raw.matchAll(/(^|\n)([ \t]{0,3})・/g)) {
          const offset = start + match.index + match[1].length + match[2].length;
          const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
          const lineEnd = source.indexOf("\n", offset + 1);
          if (/^[ \t]{0,3}$/.test(source.slice(lineStart, offset)) && source.slice(offset + 1, lineEnd < 0 ? undefined : lineEnd).trim()) markers.push(offset);
        }
      }
    } else node.children?.forEach(collect);
  };
  collect(tree);
  if (markers.length) {
    const parts: string[] = []; let cursor = 0;
    for (const offset of markers) { parts.push(source.slice(cursor, offset), "- "); cursor = offset + 1; }
    parts.push(source.slice(cursor));
    tree = markdown.parse(parts.join("")) as unknown as MdNode;
  }
  const counts = { heading: 0, listItem: 0, table: 0, paragraph: 0 };
  const math: string[] = [];
  const walk = (node: MdNode) => {
    if (node.type in counts) counts[node.type as keyof typeof counts]++;
    if (node.type === "math" || node.type === "inlineMath") math.push((node.value ?? "").replace(/\r\n/g, "\n"));
    node.children?.forEach(walk);
  };
  walk(tree);
  return { counts, math };
}

export function qualityMismatches(source: string, translated: string, opts: { from?: string; to?: string }): string[] {
  const a = qualityParts(source), b = qualityParts(translated);
  const out: string[] = [];
  if (a.math.length !== b.math.length || missingInline(a.math, b.math).length) out.push("math content changed: copy every formula exactly");
  for (const key of Object.keys(a.counts) as Array<keyof typeof a.counts>) {
    const tolerance = key === "paragraph" && a.counts[key] >= TRANSLATION_QUALITY_LIMITS.paragraphToleranceFrom ? TRANSLATION_QUALITY_LIMITS.paragraphTolerance : 0;
    if (Math.abs(a.counts[key] - b.counts[key]) > tolerance) out.push(`${key} count: ${a.counts[key]} -> ${b.counts[key]}`);
  }
  if (opts.from && opts.to && opts.from !== opts.to) {
    const length = (text: string) => [...proseOf(text).replace(/\s/g, "")].length;
    const sourceLength = length(source);
    if (sourceLength >= TRANSLATION_QUALITY_LIMITS.minProseChars) {
      const compact = (lang: string) => ["ja", "zh-Hans", "zh-Hant", "th"].includes(lang);
      const pair = compact(opts.from) && !compact(opts.to) ? "compactToSpaced" : !compact(opts.from) && compact(opts.to) ? "spacedToCompact" : "other";
      const [min, max] = TRANSLATION_QUALITY_LIMITS.ratios[pair];
      const ratio = length(translated) / sourceLength;
      if (ratio < min || ratio > max) out.push(`prose length ratio outside ${min}..${max}: translate the whole source without additions`);
    }
  }
  return out;
}

export type StructureCheck = {
  ok: boolean;
  // Mismatch descriptions, e.g. `code blocks: 2 -> 1`, `links: 1 URL(s) not in the source`.
  mismatches: string[];
  // Legacy count warnings remain visible; strong preservation failures use quality_mismatch.
  flags: string[];
};

// The mentions of the source that the translation lost: compared after NFKC and lower case ("＠Hana" and "@hana" are the same mention), in the prose of the translation
// (not in its code or math). The result is the mentions as they were passed in.
function missingMentions(mentions: readonly string[], translated: string): string[] {
  const fold = (s: string) => s.normalize("NFKC").toLowerCase();
  const prose = fold(proseOf(translated));
  return mentions.filter((mention) => !prose.includes(fold(mention)));
}

// Each source mention must survive. Retry both warning and quality failures once;
// only quality failures hide a primary translation after the retry.
export function checkStructure(source: string, translated: string, opts: { mentions?: readonly string[]; from?: string; to?: string } = {}): StructureCheck {
  const a = countStructure(source);
  const b = countStructure(translated);
  const mismatches: string[] = [];
  const flags: string[] = [];
  if (a.codeBlocks !== b.codeBlocks) mismatches.push(`code blocks: ${a.codeBlocks} -> ${b.codeBlocks}`);
  const code = checkCodeContent(source, translated, { skipFenced: a.codeBlocks !== b.codeBlocks });
  if (mismatches.length || code.countMismatch) flags.push(FLAG_STRUCTURE_MISMATCH);
  const quality = qualityMismatches(source, translated, opts);
  const mentions = missingMentions(opts.mentions ?? [], translated).map(lost => `mentions: ${lost} missing`);
  if (code.contentChanged || quality.length || mentions.length) flags.push(FLAG_QUALITY_MISMATCH);
  mismatches.push(...code.mismatches, ...quality, ...mentions);
  // Translated URLs must be a subset of original URLs. Removing is allowed; additions are invented links.
  const sourceLinks = extractLinks(source);
  const added = [...extractLinks(translated)].filter((u) => !sourceLinks.has(u));
  if (added.length > 0) {
    mismatches.push(`links: ${added.length} URL(s) in the translation that are not in the source`);
    flags.push(FLAG_LINK_MISMATCH);
  }
  return { ok: mismatches.length === 0, mismatches, flags };
}

// Plain chat has no code/math delimiters. Inspect literal URLs even inside
// backticks, plus link destinations, and preserve every source mention.
export function checkChatContent(source: string, translated: string, opts: { mentions?: readonly string[] } = {}): StructureCheck {
  const links = (text: string) => new Set([
    ...extractLinks(text),
    ...chatParts(text).filter(part => part.type === "link").map(part => normalizeUrl(part.href)),
  ]);
  const fold = (text: string) => text.normalize("NFKC").toLowerCase();
  const body = fold(translated);
  const mismatches = (opts.mentions ?? []).filter(mention => !body.includes(fold(mention))).map(mention => `mentions: ${mention} missing`);
  const flags = mismatches.length ? [FLAG_QUALITY_MISMATCH] : [];
  const original = links(source);
  const added = [...links(translated)].filter(url => !original.has(url));
  if (added.length) {
    mismatches.push(`links: ${added.length} URL(s) in the translation that are not in the source`);
    flags.push(FLAG_LINK_MISMATCH);
  }
  return { ok: !mismatches.length, mismatches, flags };
}
