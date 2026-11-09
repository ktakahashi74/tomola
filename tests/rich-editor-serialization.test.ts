import { test, expect } from "vitest";
import { remarkCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { remarkMarkdownRules } from "../app/lib/markdown-rules";
import { remarkEditorAttention } from "../app/lib/editor-markdown";
import { EDITOR_STRINGIFY_OPTIONS } from "../app/lib/rich-editor";
import { mentionTokens } from "../app/lib/mentions-md.server";
import { renderMarkdown } from "../app/lib/markdown.server";

function editorProcessor() {
  const options = remarkStringifyOptionsCtx.create(new Map()).get();
  const { strong, emphasis, text, ...handlers } = options.handlers ?? {};
  return remarkCtx.create(new Map()).get()().use(remarkMarkdownRules).use(remarkEditorAttention).data("settings", {
    ...options, ...EDITOR_STRINGIFY_OPTIONS, handlers,
  });
}

test.each([false, true])("empty command-created table cells remain valid GFM (with text: %s)", async withText => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "table", align: [null, null, null], children: Array.from({ length: 3 }, (_, row) => ({
    type: "tableRow", children: Array.from({ length: 3 }, (_, col) => withText && row === 1 && col === 1
      ? { type: "tableCell", children: [{ type: "text", value: "Cell value" }] }
      : { type: "tableCell" }),
  })) }] });
  const markdown = String(processor.stringify(tree));
  expect(processor.parse(markdown)).toMatchObject({ children: [{ type: "table", children: Array.from({ length: 3 }, (_, row) => ({
    type: "tableRow", children: Array.from({ length: 3 }, (_, col) => ({ type: "tableCell", children:
      withText && row === 1 && col === 1 ? [{ type: "text", value: "Cell value" }] : [] })),
  })) }] });
  expect(await renderMarkdown(markdown)).toContain("<table>");
});

test.each(["[Source](/t/1)\n\n", "[Shared page](https://example.org)\r\n\r\n"])("imports a trailing paragraph boundary as a typing paragraph: %s", source => {
  const processor = editorProcessor();
  const tree = processor.runSync(processor.parse(source), { value: source });
  expect(tree).toMatchObject({ children: [
    { type: "paragraph", children: [expect.objectContaining({ type: "link" })] },
    { type: "paragraph", children: [] },
  ] });
});

test.each([
  "https://g.com/h?i=1&j=2",
  "https://en.wikipedia.org/wiki/Foo_(bar)_baz",
  "https://a.com/path_",
  "https://a.com/_x_/y*z*/[1]/~u~",
  "www.b.com/p?q=1&lang=ja",
  "https://a.com/a`b",
])("typed URL punctuation survives editor serialization: %s", async url => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [{ type: "text", value: `see ${url} ok` }] }] });
  const markdown = String(processor.stringify(tree));
  const href = url.startsWith("www.") ? `http://${url}` : url;
  expect((await renderMarkdown(markdown))).toContain(`<a href="${encodeURI(href).replaceAll("&", "&#x26;")}">${url.replaceAll("&", "&#x26;")}</a>`);
  expect(processor.parse(markdown)).toMatchObject({ children: [{ type: "paragraph", children: [
    { type: "text", value: "see " }, { type: "link", url: href, children: [{ type: "text", value: url }] }, { type: "text", value: " ok" },
  ] }] });
});

test("a typed dollar reaches the Markdown-only fallback without changing math syntax", () => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [{ type: "text", value: "Formula $" }] }] });
  expect(String(processor.stringify(tree))).toBe("Formula $\n");
});

test.each(["<div>", "<script>", "<!-- comment -->", "<!DOCTYPE html>", "<![CDATA[content]]>", "<"])("does not turn inline HTML after a break into an HTML block: %s", async value => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [
    { type: "text", value: "a" }, { type: "break" }, { type: "html", value }, { type: "text", value: "x" },
  ] }] });
  const markdown = String(processor.stringify(tree));
  expect(markdown).not.toContain("\n" + value);
  expect((await renderMarkdown(markdown))).toContain("x");
});

test("retains text after a leading hard break and block HTML", async () => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [
    { type: "break" }, { type: "html", value: "<div>" }, { type: "text", value: "following text" },
  ] }] });
  expect(await renderMarkdown(String(processor.stringify(tree)))).toContain("following text");
});

test("retains a hard break before phrasing HTML", async () => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [
    { type: "text", value: "a" }, { type: "break" }, { type: "html", value: "<span>" }, { type: "text", value: "x" },
  ] }] });
  expect((await renderMarkdown(String(processor.stringify(tree))))).toContain("<br>");
});

// Exercise Milkdown's actual text handlers and installed stringifier. Plain-text
// nodes are what its editor emits; no DOM or extra dependencies are needed.

test.each(["sample_writer", "a-b_c", "a_b_c", "ends_"])("serialized text still names @%s", async handle => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [{ type: "text", value: `Hello @${handle}.` }] }] });
  const markdown = String(processor.stringify(tree));
  expect((await mentionTokens(markdown))).toEqual([handle]);
  if (!handle.endsWith("_")) expect(markdown).toContain(`@${handle}`);
});

test.each([
  ["これは", "「強調」", "です"], ["这是", "“重点”", "内容"], ["這是", "「重點」", "內容"],
  ["이것은 ", '"강조"', "입니다"], ["นี่คือ", '"คำสำคัญ"', "ในประโยค"],
  ["l'", "« important »", "est ici"], ["Das ist ", "„wichtig“", " hier"],
  ["This is ", '"important"', " here"], ["Đây là ", "“quan trọng”", " nhé"],
])("editor attention survives serialization: %s%s%s", async (before, value, after) => {
  for (const type of ["strong", "emphasis"]) {
    const processor = editorProcessor();
    const tree = processor.parse("");
    Object.assign(tree, { children: [{ type: "paragraph", children: [
      { type: "text", value: before }, { type, children: [{ type: "text", value }] }, { type: "text", value: after },
    ] }] });
    const markdown = String(processor.stringify(tree));
    const tag = type === "strong" ? "strong" : "em";
    expect((await renderMarkdown(markdown))).toContain(`<${tag}>${value}</${tag}>`);
    if (/[\u3040-\u9fff\uac00-\ud7af]/.test(before)) expect(markdown).not.toContain("&#");
  }
});

test.each(["10~20人、30~40人 ", "12. ", "2026. 10. 12. ", "use <div> ", "12.\u3000"])("escapes text immediately before attention: %s", async value => {
  const processor = editorProcessor();
  const tree = processor.parse("");
  Object.assign(tree, { children: [{ type: "paragraph", children: [
    { type: "text", value }, { type: "strong", children: [{ type: "text", value: "word" }] },
  ] }] });
  const html = (await renderMarkdown(String(processor.stringify(tree))));
  expect(html).not.toMatch(/<(ol|del|div)\b/);
  expect(html).toContain("<strong>word</strong>");
  expect(html.replace(/&#x3C;|&lt;/g, "<")).toContain(value);
});

test.each([
  "これは**「強調」**です。価格は**¥1,000**です。",
  "これは***「強調」***です", "**bold *italic*** and *italic **bold***",
  "**one** *two* **three**", "[**「リンク」**](https://example.com/)",
  "| 列 |\n| --- |\n| **「表」** |", "注[^1]\n\n[^1]: **「脚注」**",
  "これは~~「削除」~~です", "𠀀**「強調」**𠀁", "This is **important** here.",
])("serialization preserves nested and adjacent attention: %s", async source => {
  const processor = editorProcessor();
  const serialized = String(processor.stringify(processor.parse(source)));
  expect((await renderMarkdown(serialized))).toBe((await renderMarkdown(source)));
});
