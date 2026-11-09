// The card version of a rendered post: the beginning of a long body, cut on the server. The browser is sent the beginning only (it is not hidden
// with CSS: twenty long bodies are never sent to a list). The cut is made on the tree of the rendered post (sanitized, before KaTeX), not on the Markdown string, so that the result
// is always closed HTML and a formula is never cut in the middle.
//
// The rule:
//   - top-level blocks are added in order; the cut comes before the block that would take the total over CARD_MAX_CHARS characters (grapheme clusters) or CARD_MAX_ROWS rows (list items,
//     table rows and code lines: characters alone say nothing about the height of a list of short items), or after CARD_MAX_BLOCKS blocks;
//   - when the first block alone is over, it is cut inside: text at a grapheme boundary with an ellipsis ("…"); a code block by lines; a table by rows; a display formula stays whole
//     (a formula is not text, and half of it shows nothing);
//   - a later block that does not fit is dropped whole (a table, a code block and a display formula are never cut in the middle);
//   - the footnotes section is dropped (the card has nowhere to jump to), and a footnote mark that is left becomes a plain mark (no link);
//   - whether the card differs from the full text is whether `buildCardTree` returns null: null means "not cut" and the card uses the full HTML.

// How long a card shows a body: characters (grapheme clusters, as a reader counts them) and top-level blocks. Keep short posts readable in full
// (a few short paragraphs of Japanese or English fit; an essay is cut after its first paragraphs). Changing either value is a change of the rendered result: raise RENDER_VERSION.
export const CARD_MAX_CHARS = 600;
export const CARD_MAX_BLOCKS = 6;
// The rows a card shows: list items, table rows and code lines, all together (a measure of height; paragraphs are measured by their characters).
export const CARD_MAX_ROWS = 12;
// The lines of a code block and the body rows of a table that a card keeps when the first block is such a block and too long.
export const CARD_MAX_CODE_LINES = 8;
export const CARD_MAX_TABLE_ROWS = 4;

export type CardNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: CardNode[];
  value?: string;
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const isBlank = (node: CardNode): boolean => node.type === "text" && (node.value ?? "").trim() === "";

// Elements that are never cut inside when they are inline: inline code and inline formulas (`code`), images, line breaks.
const ATOMIC_INLINE = new Set(["code", "img", "br"]);

function hasClass(node: CardNode, name: string): boolean {
  const cls = node.properties?.className;
  return Array.isArray(cls) && cls.includes(name);
}

// The characters (grapheme clusters) under a node, counted up to cap + 1 (more than cap means "does not fit"; the rest is not counted, so a long body costs a few hundred steps).
function textCost(node: CardNode, cap: number): number {
  let n = 0;
  const walk = (x: CardNode): boolean => {
    if (x.type === "text") {
      if ((x.value ?? "").trim() === "") return false;
      for (const _ of segmenter.segment(x.value ?? "")) if (++n > cap) return true;
      return false;
    }
    for (const c of x.children ?? []) if (walk(c)) return true;
    return false;
  };
  walk(node);
  return n;
}

function plainText(node: CardNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(plainText).join("");
}

function codeLines(pre: CardNode): number {
  return plainText(pre).replace(/\n$/, "").split("\n").length;
}

// The rows of a block (see CARD_MAX_ROWS): list items (nested ones too), table rows, the lines of a code block. A display formula is not counted (it is kept whole or dropped whole).
function rowsOf(node: CardNode): number {
  if (node.type !== "element") return 0;
  if (node.tagName === "pre") return isDisplayMath(node) ? 0 : codeLines(node);
  const own = node.tagName === "li" || node.tagName === "tr" ? 1 : 0;
  return own + (node.children ?? []).reduce((n, c) => n + rowsOf(c), 0);
}

function firstGraphemes(text: string, count: number): { head: string; cut: boolean } {
  let head = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (used >= count) return { head, cut: true };
    head += segment;
    used++;
  }
  return { head, cut: false };
}

type CutState = { left: number; rowsLeft: number; cut: boolean };

function trimTrailingBlank(children: CardNode[]): void {
  while (children.length > 0 && isBlank(children[children.length - 1])) children.pop();
}

// Cuts the inside of one block (a paragraph, a list, a quote, a heading) after state.left characters. Text is cut at a grapheme boundary; an inline code, formula, image or break that
// does not fit is dropped whole; everything after the cut is dropped. A container that keeps nothing is dropped.
function cutWithin(node: CardNode, state: CutState): CardNode | null {
  if (node.type === "text") {
    const value = node.value ?? "";
    if (value.trim() === "") return node;
    const { head, cut } = firstGraphemes(value, state.left);
    if (cut) {
      state.cut = true;
      state.left = 0;
      return head === "" ? null : { type: "text", value: head.trimEnd() };
    }
    state.left -= [...segmenter.segment(head)].length;
    return node;
  }
  if (node.type !== "element") return node;
  if (node.tagName === "li") {
    if (state.rowsLeft <= 0) {
      state.cut = true;
      return null;
    }
    state.rowsLeft--;
  }
  if (ATOMIC_INLINE.has(node.tagName ?? "")) {
    const cost = textCost(node, state.left);
    if (cost > state.left) {
      state.cut = true;
      state.left = 0;
      return null;
    }
    state.left -= cost;
    return node;
  }
  const children: CardNode[] = [];
  for (const child of node.children ?? []) {
    if (state.cut) break;
    const kept = cutWithin(child, state);
    if (kept) children.push(kept);
  }
  trimTrailingBlank(children);
  if (state.cut && children.length === 0) return null;
  return { ...node, children };
}

// The ellipsis goes at the end of the deepest container that ends the cut block (the last paragraph, the last list item).
const ELLIPSIS_CONTAINERS = new Set(["p", "li", "ul", "ol", "blockquote", "strong", "em", "del", "a", "h1", "h2", "h3", "h4", "h5", "h6", "span", "sup", "sub"]);

function addEllipsis(container: CardNode): void {
  const children = (container.children ??= []);
  const last = children[children.length - 1];
  if (last && last.type === "element" && ELLIPSIS_CONTAINERS.has(last.tagName ?? "") && (last.children?.length ?? 0) > 0) addEllipsis(last);
  else children.push({ type: "text", value: "…" });
}

const ellipsisParagraph = (): CardNode => ({ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "…" }] });

function isDisplayMath(pre: CardNode): boolean {
  return (pre.children ?? []).some((c) => c.type === "element" && c.tagName === "code" && hasClass(c, "math-display"));
}

// A code block that is too long, as the first block: its first lines (and no more than the character limit), then a line with the ellipsis.
function cutCodeBlock(pre: CardNode): CardNode {
  const code = (pre.children ?? []).find((c) => c.type === "element" && c.tagName === "code");
  const lines = plainText(pre).replace(/\n$/, "").split("\n");
  let text = lines.slice(0, CARD_MAX_CODE_LINES).join("\n");
  const { head, cut } = firstGraphemes(text, CARD_MAX_CHARS);
  text = `${cut ? head : text}\n…`;
  return {
    type: "element",
    tagName: "pre",
    properties: pre.properties ?? {},
    children: [{ type: "element", tagName: "code", properties: code?.properties ?? {}, children: [{ type: "text", value: text }] }],
  };
}

// A table that is too long, as the first block: its header and the first rows that fit, then a paragraph with the ellipsis.
function cutTable(table: CardNode): CardNode[] {
  const parts = (table.children ?? []).filter((c) => c.type === "element");
  const head = parts.find((c) => c.tagName === "thead");
  const bodyRows = parts
    .filter((c) => c.tagName === "tbody")
    .flatMap((c) => (c.children ?? []).filter((r) => r.type === "element" && r.tagName === "tr"));
  let left = CARD_MAX_CHARS - (head ? textCost(head, CARD_MAX_CHARS) : 0);
  const kept: CardNode[] = [];
  for (const row of bodyRows) {
    const cost = textCost(row, CARD_MAX_CHARS);
    if (kept.length >= CARD_MAX_TABLE_ROWS || (kept.length > 0 && cost > left)) break;
    kept.push(row);
    left -= cost;
  }
  const children: CardNode[] = [];
  if (head) children.push(head);
  if (kept.length > 0) children.push({ type: "element", tagName: "tbody", properties: {}, children: kept });
  return [{ ...table, children }, ellipsisParagraph()];
}

// The first block alone is over the limit: cut inside it.
function cutFirstBlock(block: CardNode): CardNode[] {
  if (block.tagName === "pre") return isDisplayMath(block) ? [block] : [cutCodeBlock(block)];
  if (block.tagName === "table") return cutTable(block);
  const state: CutState = { left: CARD_MAX_CHARS, rowsLeft: CARD_MAX_ROWS, cut: false };
  const cut = cutWithin(block, state);
  if (cut === null) return [ellipsisParagraph()];
  addEllipsis(cut);
  return [cut];
}

const isFootnotes = (node: CardNode): boolean => node.type === "element" && node.tagName === "section" && node.properties?.dataFootnotes !== undefined;

// A footnote mark that is left in the card is a plain mark: the footnotes are not in the card, so there is nowhere to jump to. The link (and its id and aria-describedby) goes; the number stays.
function unlinkFootnoteMarks(node: CardNode): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "element" && child.tagName === "a" && child.properties?.dataFootnoteRef !== undefined) {
      children[i] = { type: "element", tagName: "span", properties: {}, children: child.children ?? [] };
    } else {
      unlinkFootnoteMarks(child);
    }
  }
}

// The tree of the card version of a rendered post (a hast root before KaTeX), or null when the card is the same as the full text (nothing was cut and there is no footnotes section).
// The returned tree is a copy: running KaTeX on it does not touch the tree it was made from.
export function buildCardTree(root: CardNode): CardNode | null {
  const blocks = (root.children ?? []).filter((c) => !isBlank(c));
  const footnotes = blocks.some(isFootnotes);
  const body = blocks.filter((c) => !isFootnotes(c));
  const kept: CardNode[] = [];
  let total = 0;
  let rows = 0;
  let cut = false;
  for (const block of body) {
    if (kept.length >= CARD_MAX_BLOCKS) {
      cut = true;
      break;
    }
    const cost = textCost(block, CARD_MAX_CHARS - total);
    const blockRows = rowsOf(block);
    if (total + cost > CARD_MAX_CHARS || rows + blockRows > CARD_MAX_ROWS) {
      cut = true;
      if (kept.length === 0) kept.push(...cutFirstBlock(block));
      break;
    }
    kept.push(block);
    total += cost;
    rows += blockRows;
  }
  if (!cut && !footnotes) return null;
  const children: CardNode[] = [];
  kept.forEach((block, i) => {
    if (i > 0) children.push({ type: "text", value: "\n" });
    children.push(block);
  });
  const card = structuredClone({ type: "root", children } satisfies CardNode);
  unlinkFootnoteMarks(card);
  return card;
}

// The card version of a body that could not be rendered (it is shown as escaped plain text in a <pre>): its beginning, or null when it is short.
export function cardPlainText(text: string): string | null {
  const lines = text.replace(/\n$/, "").split("\n");
  const { head, cut } = firstGraphemes(lines.slice(0, CARD_MAX_CODE_LINES * 2).join("\n"), CARD_MAX_CHARS);
  if (!cut && lines.length <= CARD_MAX_CODE_LINES * 2) return null;
  return `${head}…`;
}
