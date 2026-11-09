import { englishWordParts, isCjkTypesetting, typesetCharacters } from "./typeset-text";

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const BLOCKS = new Set(["p", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"]);

function excluded(node: Node): boolean {
  if (["code", "pre", "img"].includes(node.tagName ?? "")) return true;
  if (node.tagName === "span" && node.properties?.lang === "en") return true;
  const props = node.properties;
  if (node.tagName === "a") {
    if (Array.isArray(props?.className) && props.className.some(c => c === "mention" || c === "data-footnote-backref")) return true;
    if (props?.dataFootnoteRef !== undefined || props?.dataFootnoteBackref !== undefined) return true;
    // An ordinary link label is prose. A displayed address (including mailto) is protected as a whole.
    const text = node.children?.map(c => c.type === "text" ? c.value ?? "" : "\0").join("") ?? "";
    const href = String(props?.href ?? "");
    if (text === href || text === href.replace(/^mailto:/, "") || /^(?:[a-z][a-z0-9+.-]*:|www\.)/i.test(text)) return true;
  }
  return false;
}

// After sanitization, before image replacement and KaTeX. No raw member HTML can create these spans.
export function rehypeTypesetText(options: { lang?: string; translation?: boolean }) {
  return (tree: Node) => {
    const lang = options.lang ?? "";
    const wrap = isCjkTypesetting(lang);
    if (!wrap && !options.translation) return;
    const groups: Array<Array<Node | null>> = [];
    function collect(node: Node, group: Array<Node | null>) {
      if (excluded(node)) { group.push(null); return; }
      if (node.type === "text") { group.push(node); return; }
      if (BLOCKS.has(node.tagName ?? "")) { group = []; groups.push(group); }
      for (const child of node.children ?? []) collect(child, group);
    }
    const root: Array<Node | null> = [];
    groups.push(root);
    collect(tree, root);
    const edges = new WeakMap<Node, { left: string; right: string }>();
    for (const group of groups) {
      const text = group.map(node => node?.value ?? "\0").join("");
      const characters = options.translation ? typesetCharacters(text, lang) : null;
      let offset = 0;
      for (const node of group) {
        if (!node) { offset++; continue; }
        const length = node.value?.length ?? 0;
        // Skip words crossing inline formatting boundaries instead of labeling a partial word.
        edges.set(node, { left: text[offset - 1] ?? "", right: text[offset + length] ?? "" });
        if (characters) node.value = characters.slice(offset, offset + length).join("");
        offset += length;
      }
    }
    if (!wrap) return;
    function wrapWords(node: Node) {
      if (excluded(node) || !node.children) return;
      const children: Node[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          const edge = edges.get(child);
          for (const part of englishWordParts(child.value ?? "", edge?.left, edge?.right)) children.push(typeof part === "string"
            ? { type: "text", value: part }
            : { type: "element", tagName: "span", properties: { lang: "en" }, children: [{ type: "text", value: part.word }] });
        } else { wrapWords(child); children.push(child); }
      }
      node.children = children;
    }
    wrapWords(tree);
  };
}
