import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";

// Plain text of a Markdown post, for excerpts (search results on the page and in /search.md, the objections panel, notification e-mails, the drafts list): no heading marks,
// emphasis, link or image syntax, code fences, math delimiters, footnote marks or HTML tags. Block boundaries and <br> become spaces.
// Rules: links keep their text, images keep their alt text, code keeps its text (fences are dropped), display math is dropped, inline math keeps its source only when it is a
// short plain formula without a command or a brace (`$n$` becomes `n`, `$\frac{a}{b}$` is dropped), footnote references and definitions, other raw HTML and thematic breaks are
// dropped. Currency is not math: "$5 and $10" stays as it is (the parser reads "$5 and $" as inline math; a span that starts or ends with a space is not math).

const markdown = createMarkdownProcessor();

type MdNode = {
  type: string;
  value?: string;
  alt?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};

// An excerpt is a few hundred characters, so only the start of a post is parsed (a long post must not cost a full parse in a list of twenty results).
export const MAX_SOURCE_CHARS = 4_000;

const SIMPLE_INLINE_MATH = /^[^\\{}]{1,30}$/;

// HTML tags that end a line or a block: they become a space ("one<br>two" is two words). Any other tag is dropped without a space ("<b>bold</b>" stays one word).
const BREAKING_TAG = /^<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|h[1-6]|blockquote|pre|hr|section|article|details|summary)\b/i;

// Containers whose children are blocks (paragraphs, list items, table cells): a space goes between them. Inline containers (emphasis, links, headings)
// must not get spaces inside, or a Japanese sentence with one bold word would come out split.
const BLOCK_CONTAINERS = new Set(["root", "blockquote", "list", "listItem", "table", "tableRow"]);

const DROPPED = new Set(["math", "definition", "footnoteDefinition", "footnoteReference", "thematicBreak"]);

function collect(node: MdNode, source: string, out: string[]): void {
  if (DROPPED.has(node.type)) return;
  if (node.type === "html") {
    out.push(BREAKING_TAG.test((node.value ?? "").trimStart()) ? " " : "");
    return;
  }
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    out.push(node.value ?? "");
  } else if (node.type === "inlineMath") {
    const value = node.value ?? "";
    if (/^\s|\s$/.test(value)) {
      // "$5 and $10": not math. Put the source back, dollars included.
      const { start, end } = node.position ?? { start: {}, end: {} };
      out.push(start.offset !== undefined && end.offset !== undefined ? source.slice(start.offset, end.offset) : `$${value}$`);
    } else if (SIMPLE_INLINE_MATH.test(value.trim())) {
      out.push(value.trim());
    }
  } else if (node.type === "image") {
    out.push(node.alt ?? "");
  } else if (node.type === "break") {
    out.push(" ");
  }
  const separate = BLOCK_CONTAINERS.has(node.type);
  for (const child of node.children ?? []) {
    collect(child, source, out);
    if (separate) out.push(" ");
  }
}

// The clipped source of an excerpt, parsed (shared by the excerpts and the one-line headline of a topic without a title).
function parseStart(markdownSource: string): { root: MdNode; source: string } {
  let source = markdownSource.replace(/\r\n/g, "\n").slice(0, MAX_SOURCE_CHARS);
  // do not end in the middle of a surrogate pair
  if (/[\ud800-\udbff]$/.test(source)) source = source.slice(0, -1);
  return { root: markdown.parse(source), source };
}

export function markdownToPlainText(markdownSource: string): string {
  const { root, source } = parseStart(markdownSource);
  const out: string[] = [];
  collect(root, source, out);
  return out.join("").replace(/\s+/g, " ").trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Cuts plain text to `max` grapheme clusters (what a reader counts as characters: an emoji with a skin tone or a family emoji is one) with an ellipsis.
// trimEnd: drop the white space before the ellipsis ("ab …" becomes "ab…").
// maxUnits: also cut when the text would be longer than this many UTF-16 code units, at a grapheme boundary. A run of combining marks makes one grapheme as long as the writer
// likes, so a limit in graphemes alone does not bound the length. (If the first grapheme alone is longer than the limit, it is cut inside, at a code point.)
export function truncateGraphemes(text: string, max: number, opts: { trimEnd?: boolean; maxUnits?: number } = {}): string {
  const graphemes: string[] = [];
  let units = 0;
  const cut = (kept: string) => `${opts.trimEnd ? kept.trimEnd() : kept}…`;
  for (const { segment } of segmenter.segment(text)) {
    if (opts.maxUnits !== undefined && units + segment.length > opts.maxUnits) {
      if (graphemes.length > 0) return cut(graphemes.join(""));
      let head = "";
      for (const point of segment) {
        if (head.length + point.length > opts.maxUnits) break;
        head += point;
      }
      return cut(head);
    }
    graphemes.push(segment);
    units += segment.length;
    // one more than the limit is enough to know that the text is longer
    if (graphemes.length > max) return cut(graphemes.slice(0, max).join(""));
  }
  return text;
}

// A plain-text excerpt: Markdown removed, whitespace collapsed, cut to `max` grapheme clusters with an ellipsis.
export function plainExcerpt(markdownSource: string, max: number): string {
  return truncateGraphemes(markdownToPlainText(markdownSource), max);
}

// Containers that hold blocks: the first block with text is looked for inside them (the first item of a list, the first paragraph of a quote, the first row of a table).
const NESTING = new Set(["root", "blockquote", "list", "listItem", "table"]);

// Controls that have no place in a one-line headline: C0 (the white space ones, tab and line breaks, are collapsed to a space instead), DEL, C1, and the bidi controls (embeddings,
// overrides and isolates: they could reorder the text around the headline, in a list or a mail).
const HEADLINE_CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
// A character that shows something. White space, format characters (zero width space, joiners, the byte order mark), controls and combining marks do not, nor do the blank letters
// (Hangul fillers, the blank braille pattern).
const SHOWS_SOMETHING = /[^\p{Z}\p{C}\p{M}\u115f\u1160\u3164\uffa0\u2800]/u;

// One line of a headline: controls removed, white space collapsed. A line that shows nothing (only zero width characters, for example) is an empty string, so that the
// next block is used, and a post with no visible text at all gets the "no text" words of the screen.
function headlineLine(text: string): string {
  const line = text.replace(HEADLINE_CONTROLS, "").replace(/\s+/g, " ").trim();
  return SHOWS_SOMETHING.test(line) ? line : "";
}

function firstText(node: MdNode, source: string): string {
  if (NESTING.has(node.type)) {
    for (const child of node.children ?? []) {
      const text = firstText(child, source);
      if (text !== "") return text;
    }
    return "";
  }
  // A code block gives its first line that has anything in it (the rest is code, not a sentence).
  if (node.type === "code") return (node.value ?? "").split("\n").map(headlineLine).find((l) => l !== "") ?? "";
  const out: string[] = [];
  collect(node, source, out);
  return headlineLine(out.join(""));
}

function firstDisplayMath(node: MdNode): string {
  if (node.type === "math") return (node.value ?? "").split("\n").map(headlineLine).find((l) => l !== "") ?? "";
  for (const child of node.children ?? []) {
    const found = firstDisplayMath(child);
    if (found !== "") return found;
  }
  return "";
}

// The first block of a post that has any text, as one line of plain text (used for the headline of a topic without a title). Everything markdownToPlainText removes is removed
// here too; the first item of a list, not the whole list. Control characters and bidi controls are removed, and a block that shows nothing (only zero width characters) is
// skipped as if it were empty. A post that is only a formula (no other text) gives the first line of the formula, since there is nothing else to name it by;
// an image without alt text and nothing else gives an empty string.
export function firstBlockPlainText(markdownSource: string): string {
  const { root, source } = parseStart(markdownSource);
  return firstText(root, source) || firstDisplayMath(root);
}
