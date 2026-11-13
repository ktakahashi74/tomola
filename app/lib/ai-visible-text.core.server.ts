import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { createMarkdownProcessor } from "./markdown-rules";

type Node = { type: string; value?: string; tagName?: string; children?: Node[] };

import { visibleUnicode } from "./ai-visible-unicode.server";

// Use the site's Markdown grammar. HTML, comments, unused definitions, link
// destinations/titles and image payloads never become evidence. Supplements omit
// math; post evidence retains its source after removing invisible TeX arguments.
export function aiVisibleMarkdown(input: string, preserveMath = false): { text: string; html: string } {
  const processor = createMarkdownProcessor().use(remarkRehype).use(rehypeSanitize).use(rehypeStringify);
  const tree = processor.parse(visibleUnicode(input));
  const prune = (node: Node) => {
    if (node.children) node.children = node.children.flatMap(child => {
      if (["image", "imageReference"].includes(child.type)) return [];
      if (child.type !== "math" && child.type !== "inlineMath") return [child];
      const source = preserveMath ? visibleMathSource(child.value ?? "") : "";
      const delimiter = child.type === "math" ? "$$" : "$";
      return source.trim() ? [{ type: "text", value: `${delimiter}${source}${delimiter}` }] : [];
    });
    node.children?.forEach(prune);
  };
  prune(tree);
  const rendered = processor.runSync(tree);
  const extract = (node: Node): string => {
    if (node.type === "text") return visibleUnicode(node.value ?? "");
    const value = (node.children ?? []).map(extract).join("");
    return ["p", "li", "pre", "blockquote", "h1", "h2", "h3", "h4", "tr", "br"].includes(node.tagName ?? "") ? value + "\n" : node.tagName === "td" || node.tagName === "th" ? value + "\t" : value;
  };
  return { text: extract(rendered as Node).trim(), html: visibleUnicode(processor.stringify(rendered)) };
}

// Custom macros and styling can conceal arbitrary arguments. Omit these formulas;
// ordinary formulas retain their TeX source, without phantom payloads.
function visibleMathSource(source: string): string {
  source = source.replace(/(\\[\s\S])|%[^\n]*(?:\n|$)/g, (_, escaped: string | undefined) => escaped ?? "");
  if (/\\(?:[a-z]*def|let|futurelet|newcommand|renewcommand|providecommand|csname|mathchoice|TextOrMath|@\w*|color|textcolor|colorbox|fcolorbox|html\w*|href|url|includegraphics|raisebox|kern|mkern|[hvm]skip|[hvm]space|tmspace|(?:math)?[lrc]lap|smash|rule)\b/i.test(source)) return "";
  // KaTeX's named palette macros also expand to textcolor.
  if (/\\(?:(?:blue|green|red|purple)[A-E]?|gray[A-I]?|(?:teal|gold|maroon)[A-E]|mint[A-C]|orange|pink|kaBlue|kaGreen)\b/i.test(source)) return "";
  let result = "", cursor = 0;
  const commands = /\\[hv]?phantom\s*\{/g;
  for (let match; (match = commands.exec(source));) {
    result += source.slice(cursor, match.index);
    let depth = 1, end = commands.lastIndex;
    for (; end < source.length && depth; end++) {
      if (source[end] === "\\") { end++; continue; }
      if (source[end] === "{") depth++;
      if (source[end] === "}") depth--;
    }
    if (depth) return "";
    cursor = end; commands.lastIndex = end;
  }
  result += source.slice(cursor);
  return /\\[hv]?phantom\b/.test(result) ? "" : result;
}
