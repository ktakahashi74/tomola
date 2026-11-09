import { expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { createMarkdownProcessor } from "~/lib/markdown-rules";
import { renderMarkdown } from "~/lib/markdown.server";

type Node = { type: string; url?: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const parser = createMarkdownProcessor();
// The independent upstream grammar is the reference used by existing renders.
// Keep the custom URL extension out of this parser's expectations.
const reference = unified().use(remarkParse).use(remarkMath).use(remarkGfm, { singleTilde: false }).use(remarkCjkFriendly).use(remarkCjkStrikethrough, { singleTilde: false });
const text = (node: Node): string => node.value ?? (node.children ?? []).map(text).join("");
const links = (node: Node): Node[] => [...(node.type === "link" ? [node] : []), ...(node.children ?? []).flatMap(links)];
const signature = (tree: Node) => links(tree).map(node => ({ url: node.url, label: text(node) }));

it.each([
  ["a.b/c.d@e.com", '<p>a.b/c.<a href="mailto:d@e.com">d@e.com</a></p>'],
  ["https://x.com_e@f.co", '<p>https://x.<a href="mailto:com_e@f.co">com_e@f.co</a></p>'],
  ["_e@f.co", '<p><a href="mailto:_e@f.co">_e@f.co</a></p>'],
  ["/x.come@f.co", '<p>/x.<a href="mailto:come@f.co">come@f.co</a></p>'],
  ["x.www\\.a.com@d.co", '<p>x.<a href="http://www.a.com@d.co">www.a.com@d.co</a></p>'],
  ["xhttps\\://a.com,https\\://b.com", '<p>xhttps://a.com,<a href="https://b.com">https://b.com</a></p>'],
  ["https://.", '<p>https://.</p>'],
  ["use https://. or http:// here", '<p>use https://. or http:// here</p>'],
] as const)("preserves ordinary GFM candidate selection: %s", async (source, html) => {
  expect(await renderMarkdown(source)).toBe(html);
});

it("matches upstream link destinations, labels and known ranges for seeded ASCII input", () => {
  let seed = 0x204713;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const parts = ["https://", "http://", "www.", "a", "b.c", ".", "_", "-", "(", ")", "[", "]", "!", "?", "*", "~", "&", "amp;", ";", ":", "/", " ", "<", ">", '"', "'", ",", "@", "x.com", "\\", "`", "e@f.co", "](", "1"];
  const errors: unknown[] = [];
  for (let index = 0; index < 20_000; index++) {
    let source = "";
    const length = 3 + Math.floor(random() * 14);
    for (let part = 0; part < length; part++) source += parts[Math.floor(random() * parts.length)];
    try {
      const expected = reference.parse(source), actual = parser.parse(source);
      const expectedLinks = links(expected), actualLinks = links(actual);
      if (JSON.stringify(signature(expected)) !== JSON.stringify(signature(actual))) throw new Error(JSON.stringify({ expected: signature(expected), actual: signature(actual) }));
      for (let link = 0; link < expectedLinks.length; link++) {
        const position = actualLinks[link].position;
        if (!position || position.start.offset === undefined || position.end.offset === undefined) throw new Error("Missing source range");
        if (expectedLinks[link].position && JSON.stringify(expectedLinks[link].position) !== JSON.stringify(position)) throw new Error("Changed source range");
        if (!expectedLinks[link].position) {
          const raw = source.slice(position.start.offset, position.end.offset);
          // Upstream's text replacement has no position. Decode its reported
          // raw range independently with plain CommonMark and compare labels.
          const decoded = text(unified().use(remarkParse).parse(raw));
          if (raw !== text(actualLinks[link]) && decoded !== text(actualLinks[link])) throw new Error(JSON.stringify({ raw, label: text(actualLinks[link]) }));
        }
      }
    } catch (error) { errors.push({ source, error: String(error) }); }
  }
  expect({ count: errors.length, first: errors.slice(0, 12) }).toEqual({ count: 0, first: [] });
}, 60_000);
