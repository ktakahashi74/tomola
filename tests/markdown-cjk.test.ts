import { describe, expect, it } from "vitest";
import { renderMarkdown } from "~/lib/markdown.server";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { parseEntryReferences } from "~/lib/entry-references.server";
import { mentionTokens } from "~/lib/mentions-md.server";
import { extractLinks, checkStructure } from "~/lib/llm/structure.server";
import { offlineMarkdown } from "~/lib/site-export-format.server";

describe("shared Markdown grammar", () => {
  it.each([
    ["これは**「強調」**です", "strong", "「強調」"],
    ["これは**強調。**です", "strong", "強調。"],
    ["これは*（補足）*です", "em", "（補足）"],
    ["这是**“重点”**内容", "strong", "“重点”"],
    ["**重点：**内容在这里", "strong", "重点："],
    ["這是**「重點」**內容", "strong", "「重點」"],
    ['이것은 **"강조"**입니다', "strong", '"강조"'],
    ["**중요(important)**는 여기", "strong", "중요(important)"],
    ["これは~~「削除」~~です", "del", "「削除」"],
  ])("renders punctuation beside attention: %s", async (source, tag, text) => {
    expect((await renderMarkdown(source))).toContain(`<${tag}>${text}</${tag}>`);
    expect((await markdownToPlainText(source))).not.toMatch(/[*~]/);
  });

  it("keeps adjacent spans, nested emphasis, code, math, tables and footnotes distinct", async () => {
    expect((await renderMarkdown("これは**「強調」**です。価格は**¥1,000**です。"))).toBe("<p>これは<strong>「強調」</strong>です。価格は<strong>¥1,000</strong>です。</p>");
    expect((await renderMarkdown("これは***「強調」***です"))).toContain("<em><strong>「強調」</strong></em>");
    expect((await renderMarkdown("**bold *italic*** and _italic_ __bold__"))).toContain("<strong>bold <em>italic</em></strong>");
    const html = (await renderMarkdown("`**「literal」**`\n\n```md\n**literal**\n```\n\n$x*y$\n\n| 列 |\n| --- |\n| **「表」** |\n\n注[^1]\n\n[^1]: **「脚注」**"));
    expect(html).toContain("<code>**「literal」**</code>");
    expect(html).toContain("**literal**\n</code>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("<td><strong>「表」</strong></td>");
    expect(html).toContain("<strong>「脚注」</strong>");
  });

  it.each(["日本語_斜体_の後ろ", "日本語__強調__の後ろ", 'นี่คือ**"คำสำคัญ"**ในประโยค', "l'**« important »**est ici"])("keeps unsupported handwritten attention literal: %s", async source => {
    expect((await renderMarkdown(source))).not.toMatch(/<(strong|em)>/);
  });
  it("only double tildes delete", async () => {
    expect((await renderMarkdown("10~20人、30~40人"))).toBe("<p>10~20人、30~40人</p>");
    expect((await renderMarkdown("~~deleted~~"))).toContain("<del>deleted</del>");
  });

  it("preserves Unicode URL paths and explicitly delimited destinations", async () => {
    for (const path of ["日本語", "한글", "คำ", "a。次の文"]) {
      for (const source of [`[link](https://example.com/${path})`, `<https://example.com/${path}>`]) {
        expect([...(await extractLinks(source))]).toEqual([`https://example.com/${encodeURI(path)}`.toLowerCase()]);
      }
    }
  });

  it("agrees across rendering, plain text, mentions, references, export and translation checks", async () => {
    const source = "これは**「@writer」**です https://forum.example.org/t/12 次の文 10~20人";
    const html = (await renderMarkdown(source));
    expect(html).toContain("<strong>「@writer」</strong>");
    expect(html).toContain('href="https://forum.example.org/t/12"');
    expect((await markdownToPlainText(source))).toBe("これは「@writer」です https://forum.example.org/t/12 次の文 10~20人");
    expect((await mentionTokens(source))).toEqual(["writer"]);
    expect((await parseEntryReferences(source, "https://forum.example.org"))).toEqual([{ topicId: 12, entryId: 12, kind: "topic" }]);
    const offline = (await offlineMarkdown(source, { page: "ja/t/1.md", lang: "ja", extension: "md", posts: new Map([[12, 12]]), documents: new Set(), origin: "https://forum.example.org" }));
    expect(offline).toContain(" 次の文 10~20人");
    expect((await renderMarkdown(offline))).toContain("<strong>「@writer」</strong>");
    expect((await renderMarkdown(offline))).toContain('href="12.md"');
    expect((await checkStructure(source, "**Important:** https://forum.example.org/t/12, next sentence")).ok).toBe(true);
  });
});
