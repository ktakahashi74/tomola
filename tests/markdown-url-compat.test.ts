import { describe, expect, it } from "vitest";
import { createMarkdownProcessor } from "~/lib/markdown-rules";
import { renderMarkdown } from "~/lib/markdown.server";
import { mentionTokens } from "~/lib/mentions-md.server";
import { extractLinks } from "~/lib/llm/structure.server";

// Pin decoded destinations and labels independently of the lexical implementation.
const sharedGrammar = createMarkdownProcessor();
const escapeHtml = (value: string) => value.replaceAll("&", "&#x26;");

describe("URL compatibility", () => {
  it.each<[string, string, string, string, number, number]>([
    ["see https\\://g.com/h?i=1\\&j=2 ok", "https://g.com/h?i=1&j=2", "https://g.com/h?i=1&j=2", "https://g.com/h?i=1&j=2", 4, 29],
    ["see https\\://en.wikipedia.org/wiki/Foo\\_(bar)\\_baz ok", "https://en.wikipedia.org/wiki/Foo_(bar)_baz", "https://en.wikipedia.org/wiki/Foo_(bar)_baz", "https://en.wikipedia.org/wiki/foo_(bar)_baz", 4, 50],
    ["see https\\://a.com/path\\_ ok", "https://a.com/path_", "https://a.com/path_", "https://a.com/path", 4, 25],
    ["see https\\://a.com/\\_x\\_/y\\*z\\*/\\[1]/\\~u\\~ ok", "https://a.com/_x_/y*z*/%5B1%5D/~u~", "https://a.com/_x_/y*z*/[1]/~u~", "https://a.com/_x_/y*z*/[1]/~u", 4, 42],
    ["www\\.b.com/p?q=1\\&lang=ja", "http://www.b.com/p?q=1&lang=ja", "www.b.com/p?q=1&lang=ja", "http://www.b.com/p?q=1&lang=ja", 0, 25],
    ["https\\://g.com/h?i=1&amp;j=2", "https://g.com/h?i=1&j=2", "https://g.com/h?i=1&j=2", "https://g.com/h?i=1&j=2", 0, 28],
    ["https\\://a.com/a\\`b", "https://a.com/a%60b", "https://a.com/a`b", "https://a.com/a%60b", 0, 19],
  ])("decodes escaped URL destinations and labels: %s", async (source, href, label, normalized, start, end) => {
    const paragraph = sharedGrammar.parse(source).children[0];
    expect(paragraph.type).toBe("paragraph");
    if (paragraph.type === "paragraph") {
      const link = paragraph.children.find(node => node.type === "link");
      expect(link?.position).toEqual({ start: { line: 1, column: start + 1, offset: start }, end: { line: 1, column: end + 1, offset: end } });
      if (link?.type === "link") expect(link.children[0].position).toEqual(link.position);
    }
    expect((await renderMarkdown(source))).toContain(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
    // Translation comparison keeps its existing punctuation/case normalization.
    expect([...(await extractLinks(source))]).toEqual([normalized]);
  });

  it("reads an unspaced escaped URL without changing its spelling", async () => {
    const source = "详见https\\://g.com/h?i=1\\&j=2，然后";
    expect(await renderMarkdown(source)).toBe('<p>详见<a href="https://g.com/h?i=1&#x26;j=2">https://g.com/h?i=1&#x26;j=2</a>，然后</p>');
    expect([...(await extractLinks(source))]).toEqual(["https://g.com/h?i=1&j=2"]);
  });

  it("does not turn code or explicit link labels in a URL suffix into mentions", async () => {
    expect((await mentionTokens("https://a.com。`@writer`と[@other](https://x.com)と<b>@third</b>"))).toEqual(["third"]);
  });

  it("preserves mention positions around escaped URLs", async () => {
    const source = "@writer see https\\://b.com @other";
    expect((await mentionTokens(source))).toEqual(["writer", "other"]);
  });
});
