import { expect, test } from "vitest";
import { preserveEditorSource, prefersRichEditor, requiresMarkdownEditor } from "../app/lib/rich-editor";

test.each([[null, true], ["rich", true], ["markdown", false]])("initial preference %s selects rich=%s", (preference, rich) => {
  expect(prefersRichEditor(preference as string | null)).toBe(rich);
});

test("the source survives initialization, switching back and undo, including exact whitespace", () => {
  const original = "## 日本語\r\n\r\n* item\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\nA footnote[^note].\r\n\r\n[^note]: Text.\r\n\r\n";
  const normalized = original.replaceAll("\r\n", "\n").replace("* item", "- item").trim() + "\n";
  expect(normalized).not.toBe(original);
  expect(preserveEditorSource(original, normalized, normalized)).toBe(original);
  const edited = normalized.replace("Text.", "Edited text.");
  expect(preserveEditorSource(original, normalized, edited)).toBe(edited);
  expect(preserveEditorSource(original, normalized, normalized)).toBe(original);
  expect(preserveEditorSource("", "", "")).toBe("");
});

test.each(["Inline $x^2$.", "$$\n\\int x\\,dx\n$$", "Literal $5", "---\ntitle: Test\n---\nBody", " \r\n---\r\nlang: en\r\n---\r\nBody"])("unsafe input stays in Markdown: %s", body => {
  expect(requiresMarkdownEditor(body)).toBe(true);
});

test.each(["", "## Heading\n\n@a_b_c", "| A | B |\n| --- | --- |\n| 1 | 2 |", "Text[^1].\n\n[^1]: Footnote.", "Before\n\n---\n\nAfter"])("supported input can use the editor: %s", body => {
  expect(requiresMarkdownEditor(body)).toBe(false);
});
