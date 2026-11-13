import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { createMarkdownProcessor } from "./markdown-rules";

type Node = { type: string; value?: string; tagName?: string; children?: Node[] };

const joiningScript = /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Mongolian}\p{Script_Extensions=Devanagari}\p{Script_Extensions=Bengali}\p{Script_Extensions=Gurmukhi}\p{Script_Extensions=Gujarati}\p{Script_Extensions=Oriya}\p{Script_Extensions=Tamil}\p{Script_Extensions=Telugu}\p{Script_Extensions=Kannada}\p{Script_Extensions=Malayalam}\p{Script_Extensions=Sinhala}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}]/u;
const scriptJoin = (before: string, after: string) => /[\p{L}\p{M}]/u.test(before) && /\p{L}/u.test(after) && joiningScript.test(before) && joiningScript.test(after);

// Preserve script joiners and emoji sequences while dropping invisible payloads.
export function visibleUnicode(input: string): string {
  const chars = [...input.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n")];
  return chars.filter((char, i) => {
    const before = chars[i - 1] ?? "", after = chars[i + 1] ?? "";
    if (char === "\u200c") return scriptJoin(before, after);
    if (char === "\u200d") {
      let base = i - 1;
      if (/\p{Emoji_Modifier}/u.test(chars[base] ?? "")) base--;
      if (chars[base] === "\ufe0f") base--;
      return (/\p{Extended_Pictographic}/u.test(chars[base] ?? "") && /\p{Extended_Pictographic}/u.test(after)) || scriptJoin(before, after);
    }
    if (char === "\ufe0e" || char === "\ufe0f") return /\p{Emoji}/u.test(before);
    if (/\p{Default_Ignorable_Code_Point}/u.test(char)) return false;
    return !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(char);
  }).join("");
}

// Use the site's Markdown grammar. HTML, comments, unused definitions, link
// destinations/titles and image payloads never become evidence. Math is omitted
// because TeX can hide arbitrary text with commands such as phantom.
export function aiVisibleMarkdown(input: string): { text: string; html: string } {
  const processor = createMarkdownProcessor().use(remarkRehype).use(rehypeSanitize).use(rehypeStringify);
  const tree = processor.parse(visibleUnicode(input));
  const prune = (node: Node) => {
    if (node.children) node.children = node.children.filter(child => !["image", "imageReference", "math", "inlineMath"].includes(child.type));
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
