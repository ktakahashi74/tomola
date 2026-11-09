import { describe, expect, it } from "vitest";
import { checkRenderable, renderMarkdown, renderMarkdownOrPlain } from "~/lib/markdown.server";

describe("renderMarkdown", () => {
  it("adds heading anchors only when an explicit prefix is supplied", async () => {
    const markdown = "# Start\n\n## Section\n\n### Detail\n\n#### End";
    for (const options of [{}, { lang: "ja" }]) {
      expect((await renderMarkdown(markdown, options))).not.toMatch(/<h[1-4][^>]*\sid=/);
    }
    expect((await renderMarkdown(markdown, { headingIdPrefix: "p-7-" }))).toContain('id="p-7-h-1"');
    expect((await renderMarkdown(markdown, { idPrefix: "user-content-" }))).toContain('id="user-content-h-1"');
  });

  it("numbers h1 through h4 after sanitization without trusting author HTML IDs", async () => {
    const html = (await renderMarkdown('# Start\n\n## Same\n\n<h2 id="chosen">Ignored</h2>\n\n### Same\n\n#### End\n\n##### Small\n\ntext[^1]\n\n[^1]: note', { idPrefix: "p-7-" }));
    expect([...html.matchAll(/<h[1-4] id="(p-7-h-\d+)"/g)].map(match => match[1])).toEqual(["p-7-h-1", "p-7-h-2", "p-7-h-3", "p-7-h-4"]);
    expect(html).not.toContain('id="chosen"');
    expect(html).toContain('id="p-7-footnote-label"');
    const reply = (await renderMarkdown("## Same", { idPrefix: "c-8-" }));
    expect(reply).toContain('id="c-8-h-1"');
    expect(reply).not.toContain('id="p-7-h-1"');
  });

  it("shares numbered headings across languages while keeping footnotes separate", async () => {
    const original = (await renderMarkdown("## はじめ\n\n### 結び\n\ntext[^1]\n\n[^1]: note", { idPrefix: "p-7-", lang: "ja" }));
    const translated = (await renderMarkdown("## Beginning\n\n### End\n\ntext[^1]\n\n[^1]: note", { idPrefix: "p-7-en-", headingIdPrefix: "p-7-", lang: "en" }));
    const headings = (html: string) => [...html.matchAll(/<h[1-4] id="([^"]+h-\d+)"/g)].map(match => match[1]);
    expect(headings(translated)).toEqual(headings(original));
    expect(translated).toContain('href="#p-7-en-fn-1"');
    expect(translated).toContain('id="p-7-en-footnote-label"');
  });

  it("renders emphasis", async () => {
    expect((await renderMarkdown("**x**"))).toContain("<strong>x</strong>");
  });

  it("drops raw HTML", async () => {
    // Under CommonMark, a line-start <script> makes the entire line an HTML block, including the following "hi", so it is dropped.
    // Separate the fixture that drops content from the fixture that preserves surrounding prose.
    expect((await renderMarkdown("<script>alert(1)</script>hi"))).not.toContain("<script");
    const html = (await renderMarkdown("hi\n\n<script>alert(1)</script>"));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
    expect(html).toContain("hi");
  });

  it("removes javascript: links", async () => {
    expect((await renderMarkdown("[x](javascript:alert(1))"))).not.toContain("javascript:");
  });

  it("renders inline math with KaTeX", async () => {
    expect((await renderMarkdown("$x^2$"))).toContain('class="katex"');
  });

  it("renders display math with KaTeX", async () => {
    expect((await renderMarkdown("$$\n\\int_0^1 x\\,dx\n$$"))).toContain("katex-display");
  });

  it("renders GFM tables", async () => {
    expect((await renderMarkdown("|a|b|\n|-|-|\n|1|2|"))).toContain("<table>");
  });

  it("keeps non-Latin text intact", async () => {
    expect((await renderMarkdown("共生と制御"))).toContain("共生と制御");
  });

  it("keeps footnote ids and hrefs consistent", async () => {
    const html = (await renderMarkdown("text[^1]\n\n[^1]: note"));
    // Footnote links in both directions refer to existing IDs.
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('id="user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain('id="user-content-fnref-1"');
    expect(html).not.toContain("user-content-user-content-");
  });

  it("prefixes footnote ids consistently and keeps two renders on one page apart", async () => {
    const md = "text[^1]\n\n[^1]: note";
    const a = (await renderMarkdown(md, { idPrefix: "p-1-" }));
    const b = (await renderMarkdown(md, { idPrefix: "c-2-" }));
    const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    const hrefs = (html: string) => [...html.matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
    const describedBy = (html: string) => [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((x) => x[1]);

    for (const [html, prefix] of [
      [a, "p-1-"],
      [b, "c-2-"],
    ]) {
      expect(ids(html)).toEqual(expect.arrayContaining([`${prefix}fn-1`, `${prefix}fnref-1`, `${prefix}footnote-label`]));
      // Check that href and aria-describedby targets exist in the body; assert a nonempty set first.
      expect(hrefs(html).length).toBeGreaterThan(0);
      expect(describedBy(html).length).toBeGreaterThan(0);
      for (const target of [...hrefs(html), ...describedBy(html)]) expect(ids(html)).toContain(target);
      expect(html).not.toContain("user-content-");
    }
    // The two bodies must not share IDs.
    const all = [...ids(a), ...ids(b)];
    expect(new Set(all).size).toBe(all.length);
  });

  describe("XSS regressions", () => {
    it("does not let KaTeX \\href produce a link", async () => {
      expect((await renderMarkdown("$\\href{javascript:alert(1)}{x}$"))).not.toContain("href=");
    });

    it("does not let KaTeX \\htmlClass inject classes", async () => {
      // When trust is enabled, KaTeX produces class="enclosing evil"; search for this word.
      expect((await renderMarkdown("$\\htmlClass{evil}{x}$"))).not.toMatch(/class="[^"]*\bevil\b/);
    });

    it("drops inline <img> with event handlers", async () => {
      const html = (await renderMarkdown("a <img src=x onerror=alert(1)> b"));
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("<img");
    });

    it("drops data: image URLs", async () => {
      expect((await renderMarkdown("![x](data:text/html,alert(1))"))).not.toContain("data:");
    });

    it("drops inline <script> but keeps surrounding text", async () => {
      const html = (await renderMarkdown("hi <script>alert(1)</script>"));
      expect(html).not.toContain("<script");
      expect(html).toContain("hi");
    });

    it("clamps oversized KaTeX rules with maxSize", async () => {
      const html = (await renderMarkdown("$\\rule{10000em}{10000em}$"));
      // The annotation retains raw TeX; inspect only the rendered portion.
      const rendered = html.replace(/<annotation[\s\S]*?<\/annotation>/g, "");
      expect(rendered).not.toContain("10000em");
      expect(rendered).toContain("10em");
    });
  });

  describe("checkRenderable", () => {
    it("accepts a normal body", async () => {
      expect((await checkRenderable("# 見出し\n\n本文 $x^2$\n\n- a\n- b"))).toBe(true);
    });

    it("rejects deeply nested lists (stack overflow)", async () => {
      // Repeated "- " forms a thematic break; append a character to make it a nested list.
      expect((await checkRenderable("- ".repeat(2000) + "x"))).toBe(false);
      expect((await checkRenderable("1. ".repeat(2000) + "x"))).toBe(false);
      // Rendering runs until stack exhaustion and can exceed the default five-second timeout when other test files run in parallel.
    }, 30_000);

    it("rejects deeply nested quotes (stack overflow)", async () => {
      expect((await checkRenderable(">".repeat(3000)))).toBe(false);
    });

    it("rejects a short body that renders to a huge output", async () => {
      expect((await checkRenderable("$x^2$ ".repeat(3000)))).toBe(false);
    });
  });

  describe("renderMarkdownOrPlain", () => {
    it("renders a normal body as Markdown", async () => {
      expect((await renderMarkdownOrPlain("**x**"))).toContain("<strong>x</strong>");
    });

    it("falls back to escaped text in a pre when rendering throws", async () => {
      const body = `<script>alert("x")</script> & 'q'\n` + ">".repeat(3000);
      await expect(renderMarkdown(body)).rejects.toThrow();
      const html = (await renderMarkdownOrPlain(body));
      expect(html.startsWith('<pre class="whitespace-pre-wrap">')).toBe(true);
      expect(html.endsWith("</pre>")).toBe(true);
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
      expect(html).not.toContain("<script");
    });
  });
});
