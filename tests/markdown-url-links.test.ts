import { describe, expect, it } from "vitest";
import { createMarkdownProcessor } from "~/lib/markdown-rules";
import { renderMarkdown } from "~/lib/markdown.server";
import { mentionTokens } from "~/lib/mentions-md.server";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { parseEntryReferences } from "~/lib/entry-references.server";
import { extractLinks, checkStructure } from "~/lib/llm/structure.server";
import { offlineMarkdown } from "~/lib/site-export-format.server";

const markdown = createMarkdownProcessor();
type MdNode = { type: string; url?: string; value?: string; children?: MdNode[]; position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } } };
const descendants = (node: MdNode): MdNode[] => [node, ...(node.children ?? []).flatMap(descendants)];
const links = (source: string) => descendants(markdown.parse(source)).filter(node => node.type === "link");

describe("bare URL boundaries", () => {
  it.each([..."。、，．：；！？・…‥「」『』（）［］【】〈〉《》〔〕｛｝〜‘’“”"])("ends before %s and returns the suffix to Markdown", async punctuation => {
    for (const sourceUrl of ["https://a.com", "http://a.com", "www.a.com", "https\\://a.com", "www\\.a.com"]) {
      const label = sourceUrl.replaceAll("\\", "");
      const href = label.startsWith("www") ? "http://www.a.com" : label;
      const source = sourceUrl + punctuation + "**太字**、`code`、[リンク](https://b.com)、https://c.com です";
      expect(await renderMarkdown(source)).toBe(`<p><a href="${href}">${label}</a>${punctuation}<strong>太字</strong>、<code>code</code>、<a href="https://b.com">リンク</a>、<a href="https://c.com">https://c.com</a> です</p>`);
    }
  });

  it.each(["日本語", "かな", "한글", "คำ"])("keeps address letters: %s", async suffix => {
    expect(links(`https://a.com/${suffix}。続き`).map(node => node.url)).toEqual([`https://a.com/${suffix}`]);
    expect(await renderMarkdown(`https://a.com/${suffix}。続き`)).toBe(`<p><a href="https://a.com/${encodeURI(suffix)}">https://a.com/${suffix}</a>。続き</p>`);
  });

  it.each([
    ["https://a.com。$x_1$と注[^1]\n\n[^1]: note", ["link", "inlineMath", "footnoteReference", "footnoteDefinition"]],
    ["https://a.com。~~削除~~", ["link", "delete"]],
    ["https://a.com。`@writer`と[@other](https://x.com)と<b>@third</b>", ["link", "inlineCode", "html"]],
  ] as const)("reads following syntax in the original document: %s", async (source, types) => {
    const nodes = descendants(markdown.parse(source));
    for (const type of types) expect(nodes.some(node => node.type === type)).toBe(true);
    const html = await renderMarkdown(source);
    expect(html).toContain('<a href="https://a.com">https://a.com</a>。');
    if (types.includes("inlineMath" as never)) { expect(html).toContain('class="katex"'); expect(html).toContain('data-footnote-ref'); }
    if (types.includes("delete" as never)) expect(html).toContain("<del>削除</del>");
  });

  it.each([
    ["https://a.com、https://b.com を参照", ["https://a.com", "https://b.com"]],
    ["https://a.com、https\\://b.com、https://c.com", ["https://a.com", "https://b.com", "https://c.com"]],
    ["see https\\://a.com and 详见https\\://b.com，然后", ["https://a.com", "https://b.com"]],
    ["“https://a.com/x”和‘https://b.com’", ["https://a.com/x", "https://b.com"]],
    ["https&#x3a;//a.com。&amp;amp; \\\\\\*x", ["https://a.com"]],
    ["https://example.com/日本語。続き", ["https://example.com/日本語"]],
    ["詳しくはhttps://example.com/a。**注意**してください。`code`と[リンク](https://b.com)と~~消し~~", ["https://example.com/a", "https://b.com"]],
  ])("keeps separate destinations: %s", (source, urls) => {
    for (const prefix of ["", "前文 ", "😀\r\n\r\n", "# heading\n\n"]) expect(links(prefix + source).map(node => node.url)).toEqual(urls);
  });

  it.each([
    ["(https://a.com/a_(b)).", "https://a.com/a_(b)"],
    ["https://a.com/x!!!。続き", "https://a.com/x"],
    ["https://a.com/x.,:;?", "https://a.com/x"],
    ["www.a.com/x。続き", "http://www.a.com/x"],
    ["writer@example.com。続き", "mailto:writer@example.com"],
    ["[https://a.com。次](https://b.com/。次)", "https://b.com/。次"],
    ["<https://a.com/。次>", "https://a.com/。次"],
  ])("keeps GFM punctuation, mail and explicit destinations: %s", (source, url) => {
    expect(links(source).map(node => node.url)).toEqual([url]);
  });

  it("decodes references once and leaves suffix references to Markdown", async () => {
    expect(await renderMarkdown("https&#x3a;//a.com。&amp;amp; \\*literal\\* &#64;hidden")).toBe('<p><a href="https://a.com">https://a.com</a>。&#x26;amp; *literal* @hidden</p>');
  });

  it("retains exact UTF-16 offsets, CRLF lines and heading columns", () => {
    const source = "前文😀\r\n\r\n# @writer https\\://a.com。**太字** @other";
    const heading = markdown.parse(source).children[1] as MdNode;
    expect(heading.children).toMatchObject([
      { type: "text", value: "@writer ", position: { start: { line: 3, column: 3, offset: 10 }, end: { line: 3, column: 11, offset: 18 } } },
      { type: "link", url: "https://a.com", position: { start: { line: 3, column: 11, offset: 18 }, end: { line: 3, column: 25, offset: 32 } }, children: [{ type: "text", value: "https://a.com", position: { start: { line: 3, column: 11, offset: 18 }, end: { line: 3, column: 25, offset: 32 } } }] },
      { type: "text", value: "。", position: { start: { line: 3, column: 25, offset: 32 }, end: { line: 3, column: 26, offset: 33 } } },
      { type: "strong", position: { start: { line: 3, column: 26, offset: 33 }, end: { line: 3, column: 32, offset: 39 } }, children: [{ type: "text", value: "太字", position: { start: { line: 3, column: 28, offset: 35 }, end: { line: 3, column: 30, offset: 37 } } }] },
      { type: "text", value: " @other", position: { start: { line: 3, column: 32, offset: 39 }, end: { line: 3, column: 39, offset: 46 } } },
    ]);
    for (const node of descendants(markdown.parse(source))) expect(node.position).toBeDefined();
  });

  it.each([
    "@writer see https\\://b.com @other", "@writer see https://b.com @other @third",
    "@writer see https\\://b.com \\@silent &#64;hidden `@code` @other",
  ])("keeps mentions beside URLs and excludes decoded sigils: %s", async source => {
    expect(await mentionTokens(source)).toEqual(source.endsWith("@third") ? ["writer", "other", "third"] : ["writer", "other"]);
  });

  it.each([
    ["https\\://a.com_", '<p>https://a.com_</p>'],
    ["https\\://a.com/x\\__", '<p><a href="https://a.com/x__">https://a.com/x__</a></p>'],
    ["https\\://a\\_b.com", '<p>https://a_b.com</p>'],
    ["https\\://a.com](https://b.com)", '<p><a href="https://a.com%5D(">https://a.com](</a><a href="https://b.com">https://b.com</a>)</p>'],
    ["[https://a.com", '<p>[<a href="https://a.com">https://a.com</a></p>'],
    ["[http://a.com/a_(b)", '<p>[<a href="http://a.com/a_(b)">http://a.com/a_(b)</a></p>'],
    ["[https://a.com.*x", '<p>[<a href="https://a.com.*x">https://a.com.*x</a></p>'],
    ['"www.a.com_', '<p>"www.a.com_</p>'],
    ["www.a_b.com.", '<p><a href="http://www.a_b.com">www.a_b.com</a>.</p>'],
    ["www.a_b.com", '<p>www.a_b.com</p>'],
    ["writer&#64;example.com", '<p><a href="mailto:writer@example.com">writer@example.com</a></p>'],
    ["[label https://a.com/*x*](https://b.com)", '<p><a href="https://b.com">label https://a.com/<em>x</em></a></p>'],
    ["![https://a.com](https://b.com/image.png)", '<p><a href="https://b.com/image.png" rel="nofollow noopener noreferrer">https://a.com</a></p>'],
    ["[https://a.com][ref]\n\n[ref]: https://b.com", '<p><a href="https://b.com">https://a.com</a></p>'],
  ])("keeps literal-text GFM recognition before building nodes: %s", async (source, html) => {
    expect(await renderMarkdown(source)).toBe(html);
  });

  it("keeps positions through unresolved labels, escaped separators and references", async () => {
    const source = "😀\r\n\r\n# [@writer https\\://a.com。**太字** @other";
    const nodes = descendants(markdown.parse(source));
    const link = nodes.find(node => node.type === "link")!;
    expect(link).toMatchObject({ url: "https://a.com", position: { start: { line: 3, column: 12, offset: 17 }, end: { line: 3, column: 26, offset: 31 } } });
    expect(link.children![0].position).toEqual(link.position);
    for (const node of nodes) expect(node.position).toBeDefined();
    expect(await mentionTokens(source)).toEqual(["writer", "other"]);
    const referenced = links("[@writer https&#58;//a.com。next @other")[0];
    expect(referenced).toMatchObject({ url: "https://a.com", position: { start: { line: 1, column: 10, offset: 9 }, end: { line: 1, column: 27, offset: 26 } } });
  });

  it("accepts long URLs and punctuation runs in the bounded worker", async () => {
    for (const source of [
      "https://a.com/" + "a".repeat(40_000) + "。**end**",
      "https://a.com/" + ".".repeat(40_000) + "x。**end**",
      "[https://a.com。" + ".".repeat(40_000) + "x。**end**",
      "[" + "https://a.com。".repeat(2_500) + "**end**",
    ]) expect(await renderMarkdown(source)).toContain("<strong>end</strong>");
  });

  it("agrees across extracts, exports, plain text and translation comparison", async () => {
    const source = "@writer https\\://forum.example.org/t/12。**太字** @other";
    expect(await mentionTokens(source)).toEqual(["writer", "other"]);
    expect(await markdownToPlainText(source)).toBe("@writer https://forum.example.org/t/12。太字 @other");
    expect(await parseEntryReferences(source, "https://forum.example.org")).toEqual([{ topicId: 12, entryId: 12, kind: "topic" }]);
    expect([...(await extractLinks(source))]).toEqual(["https://forum.example.org/t/12"]);
    const exported = await offlineMarkdown(source, { page: "ja/t/1.md", lang: "ja", extension: "md", posts: new Map([[12, 12]]), documents: new Set(), origin: "https://forum.example.org" });
    expect(await renderMarkdown(exported)).toContain('<a href="12.md">https://forum.example.org/t/12</a>。<strong>太字</strong> @other');
    expect((await checkStructure("詳細はhttps://example.com/paperを参照。", "See https://example.com/paper for details.")).ok).toBe(true);
    expect((await checkStructure("https://a.com。次", "https://evil.com。次")).flags).toContain("link_mismatch");
  });
});
