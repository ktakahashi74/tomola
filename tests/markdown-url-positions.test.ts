import { expect, it } from "vitest";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { createMarkdownProcessor } from "~/lib/markdown-rules";
import { renderMarkdown } from "~/lib/markdown.server";
import { renderMarkdown as renderCore } from "~/lib/markdown.core.server";
import { mentionTokens } from "~/lib/mentions-md.server";

type Node = { type: string; value?: string; url?: string; children?: Node[]; position?: { start: { offset?: number; line: number; column: number }; end: { offset?: number; line: number; column: number } } };
const descendants = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(descendants)];
const parser = createMarkdownProcessor();
const commonmark = unified().use(remarkParse);
const text = (node: Node): string => node.value ?? (node.children ?? []).map(text).join("");

// Decode only literal escapes/references. Do not infer source positions from
// the URL matcher or reconstruct the tokenizer's chunk indexes in this oracle.
function literal(raw: string): string {
  return raw.replace(/\\([!-/:-@[-`{-~])|&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, escaped) => escaped ?? text(commonmark.parse(match))).replaceAll("\0", "�");
}

it.each([
  ["a\tb https\\://c.com", '<p>a\tb <a href="https://c.com">https://c.com</a></p>', 4, 18, "https://c.com"],
  ["前\t後 www\\.a.com、次", '<p>前\t後 <a href="http://www.a.com">www.a.com</a>、次</p>', 4, 14, "http://www.a.com"],
  ["a\tb [https://c.com d", '<p>a\tb [<a href="https://c.com">https://c.com</a> d</p>', 5, 18, "https://c.com"],
  ["x日本\thttps\\://a.com@u", '<p>x日本\t<a href="https://a.com@u">https://a.com@u</a></p>', 4, 20, "https://a.com@u"],
  ["https\\://a.com x\ty https\\://b.com", '<p><a href="https://a.com">https://a.com</a> x\ty <a href="https://b.com">https://b.com</a></p>', 19, 33, "https://b.com"],
  ["https://b.com/x\thttps\\://a.com x", '<p><a href="https://b.com/x">https://b.com/x</a>\t<a href="https://a.com">https://a.com</a> x</p>', 16, 30, "https://a.com"],
] as const)("retains URL source spans across tabs: %s", async (source, html, start, end, url) => {
  expect(await renderMarkdown(source)).toBe(html);
  const link = descendants(parser.parse(source)).find(node => node.type === "link" && node.url === url)!;
  expect(link?.position).toEqual({ start: { offset: start, line: 1, column: start + 1 }, end: { offset: end, line: 1, column: end + 1 } });
  expect(link?.children?.[0].position).toEqual(link?.position);
  expect(literal(source.slice(start, end))).toBe(link?.children?.[0].value);
});

it("retains mentions at tab boundaries and escaped sigil exclusions", async () => {
  for (const prefix of ["a\t", "ab\t", "abc\t", "abcd\t", "a\t\t", "😀\t"]) {
    const source = `@writer ${prefix}see https\\://b.com\t@other \\@silent &#64;hidden`;
    expect(await mentionTokens(source)).toEqual(["writer", "other"]);
  }
});

it("retains source columns through CRLF and tab padding in a block quote", async () => {
  const source = "> a\tb https\\://c.com\r\n>\t前 https\\://d.com。**次**";
  expect(await renderMarkdown(source)).toBe('<blockquote>\n<p>a\tb <a href="https://c.com">https://c.com</a>\r\n前 <a href="https://d.com">https://d.com</a>。<strong>次</strong></p>\n</blockquote>');
  const links = descendants(parser.parse(source)).filter(node => node.type === "link");
  expect(links.map(node => node.position)).toEqual([
    { start: { line: 1, column: 7, offset: 6 }, end: { line: 1, column: 21, offset: 20 } },
    { start: { line: 2, column: 5, offset: 26 }, end: { line: 2, column: 19, offset: 40 } },
  ]);
});

it("retains literal source ranges through seeded tabs, indentation, references and CRLF", () => {
  let seed = 0x5a17c9;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const prefixes = ["", "a\tb ", "前\t後 ", "ab\t", "abc\t", "abcd\t", "a\t\t", "  ", "   ", "\t", "# ", "> ", "- ", "1. ", "  > ", "前😀\r\n\r\n# "];
  const parts = ["https\\://a.com", "https://b.com/x", "www.c.com", "www\\.d.com", "\t", " ", "x", "。", "、", "[", "]", "(", ")", "*", "_", "&amp;", "&#58;", "@u", "`", "~~", "日本", "\\", ".", "e@f.com", "\r\n\r\n", "&#x1f600;", "&NotEqualTilde;"];
  const errors: unknown[] = [];
  for (let index = 0; index < 4_000; index++) {
    let source = pick(prefixes);
    const length = 2 + Math.floor(random() * 10);
    for (let part = 0; part < length; part++) source += pick(parts);
    try {
      const tree = parser.parse(source);
      renderCore(source);
      for (const node of descendants(tree)) {
        if (node.type !== "text") continue;
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (start === undefined || end === undefined || start < 0 || end < start || end > source.length) throw new Error("Missing or invalid source range");
        const raw = source.slice(start, end);
        if (raw !== node.value && literal(raw) !== node.value) throw new Error(JSON.stringify({ value: node.value, raw, start, end }));
      }
    } catch (error) {
      errors.push({ source, error: String(error) });
    }
  }
  expect({ count: errors.length, first: errors.slice(0, 8) }).toEqual({ count: 0, first: [] });
}, 30_000);
