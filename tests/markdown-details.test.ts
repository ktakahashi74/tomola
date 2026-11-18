import { describe, expect, it, vi } from "vitest";
import { createMarkdownProcessor } from "~/lib/markdown-rules";
import { renderEntry, renderMarkdown, inspectDraftRendering } from "~/lib/markdown.core.server";
import { checkStructure, proseOf } from "~/lib/llm/structure.core.server";
import { HIDDEN_PRIMARY_FLAGS, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH } from "~/lib/llm/flags";
import { readingInfo } from "~/lib/reading.server";
import { remarkCtx } from "@milkdown/kit/core";
import { remarkMarkdownRules } from "~/lib/markdown-rules";
import { checkDraftIssues } from "~/lib/draft-issues.server";
import { createTestDb, addMember } from "./helpers/db";
import { createTopic } from "~/lib/entries.server";
import { entries } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { remarkEditorAttention } from "~/lib/editor-markdown";
import { markdownToPlainText } from "~/lib/plain-text.core.server";
import { offlineMarkdown } from "~/lib/site-export-format.core.server";
import { EDITOR_STRINGIFY_OPTIONS } from "~/lib/rich-editor";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { translateChecked } from "~/lib/llm/translate.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { isUsablePrimary } from "~/lib/display";
import { decorateFigureHtml, figureImageIds } from "~/lib/figure-display.server";
import { figurePath } from "~/lib/figure";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const fold = (body: string, summary = "More", colons = 3) => `${":".repeat(colons)}details[${summary}]\n${body}\n${":".repeat(colons)}`;

describe("bounded Markdown details", () => {
  it.each(["例:abc", "10:30", "::leaf[x]", ":span[x]", "::: 固定 :::", ":::"])("keeps non-container syntax literal: %s", source => {
    expect(renderMarkdown(source)).toBe(`<p>${source}</p>`);
  });

  it("renders summary math and emphasis but removes summary interactions", () => {
    const html = renderMarkdown(fold("Body.", "$x^2$ and **bold** [label](https://example.org) [ref][r] ![alt](/x) note[^n]") + "\n\n[r]: /ref\n\n[^n]: Note.");
    const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
    expect(summary).toContain('class="katex"');
    expect(summary).toContain("<strong>bold</strong>");
    expect(summary).toContain("label ref alt note");
    expect(summary).not.toMatch(/<(?:a|img|button)\b/);
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    expect(renderMarkdown(fold("Body", ""))).toContain("<summary>Details</summary>");
    expect(renderMarkdown(fold("本文", ""), { lang: "ja" })).toContain("<summary>くわしく</summary>");
  });

  it("uses the standard colon fence lengths for nesting and closing", () => {
    expect(renderMarkdown("::::details[Outer]\n:::details[Inner]\nBody\n:::\n:::::" ).match(/<details>/g)).toHaveLength(2);
    const unclosed = "::::details[Title]\nBody\n:::";
    expect(renderMarkdown(unclosed)).not.toContain("<details>");
    expect(inspectDraftRendering(unclosed, "en").issues[0].detailsReason).toBe("unclosed");
  });

  it("renders rich blocks, list containers, nested containers, and prefixed footnotes", () => {
    const body = "$$\nx^2\n$$\n\n| A | B |\n| - | - |\n| C | D |\n\n```bibtex\n@book{sample}\n```\n\n![Image](/media/" + "a".repeat(64) + "-10x10.webp)\n\nRef[^n].\n\n[^n]: Note.";
    const html = renderMarkdown(fold(body), { idPrefix: "p-1-", lang: "en" });
    for (const tag of ['class="katex-display"', "<table>", '<code class="language-bibtex">', "<img ", 'id="p-1-fnref-n"', 'href="#p-1-fn-n"', 'href="#p-1-fnref-n"']) expect(html).toContain(tag);
    expect(renderMarkdown("- Item\n\n  " + fold("Body").replaceAll("\n", "\n  "))).toContain("<details>");
    const nested = fold(fold(fold("Deep", "Third"), "Second", 4), "First", 5);
    const result = renderMarkdown(nested);
    expect(result.match(/<details>/g)).toHaveLength(2);
    expect(result).toContain(":::details[Third]\nDeep\n:::");
    expect(inspectDraftRendering(nested, "en").issues).toMatchObject([{ kind: "details_literal", detailsReason: "depth", location: { field: "body", line: 3 } }]);
  });

  it.each([
    [":::unknown[Title]\nBody\n:::", "name"],
    [":::details[Title]\nBody\n\n## Following\n\nVisible", "unclosed"],
    [":::details[Title]{#evil .c open name=n}\nBody\n:::", "attributes"],
    [":::details[Title]{}\nBody\n:::", "attributes"],
  ])("keeps rejected containers as source text and reports why: %s", (source, reason) => {
    const html = renderMarkdown(source + "\n\nAfter");
    expect(html).not.toContain("<details");
    expect(html).toContain(source);
    expect(html).toContain("After");
    expect(inspectDraftRendering(source, "en").issues).toMatchObject([{ kind: "details_literal", detailsReason: reason, location: { field: "body", line: 1 }, excerpt: source.slice(0, 80) }]);
  });

  it("keeps following blocks outside rejected explicitly closed containers", () => {
    for (const opening of [":::unknown[Title]", ":::details[Title]{open}"]) {
      const html = renderMarkdown(opening + "\nBody\n:::\n\n## Following\n\nVisible", { idPrefix: "p-1-" });
      expect(html).toContain('<h2 id="p-1-h-1">Following</h2>\n<p>Visible</p>');
    }
  });

  it("rejects a container ending implicitly at its parent and drops raw HTML", () => {
    const source = "> :::details[Unclosed]\n> Inside\n\n## Outside\n\nAfter";
    const html = renderMarkdown(source, { idPrefix: "p-1-" });
    expect(html).not.toContain("<details>");
    expect(html).toContain('<h2 id="p-1-h-1">Outside</h2>');
    expect(html).toContain("After");
    expect(renderMarkdown('<details open id="evil"><summary>Raw</summary>Hidden</details>')).toBe("");
    expect(renderMarkdown(fold('<script>alert(1)</script>\n\nSafe'))).not.toContain("<script");
  });

  it("uses only summary text for cards, including nested lists and large hidden bodies", () => {
    const { html, cardHtml } = renderEntry(fold("Secret ".repeat(1000), "Short") + "\n\nVisible.");
    expect(html).toContain("Secret");
    expect(cardHtml).toBe("<p>Short</p>\n<p>Visible.</p>");
    const list = renderEntry("- Item\n\n  " + fold("Secret", "Short").replaceAll("\n", "\n  "));
    expect(list.cardHtml).toContain("Short");
    expect(list.cardHtml).not.toContain("Secret");
    expect(renderEntry(fold("- item\n".repeat(50), "Short")).cardHtml).toBe("<p>Short</p>");
    const rows = "> " + ("- item\n".repeat(11) + "\n" + fold("Hidden", "First") + "\n\n" + fold("Hidden", "Too many")).replaceAll("\n", "\n> ");
    const card = renderEntry(rows).cardHtml;
    expect(card).toContain("First");
    expect(card).not.toContain("Too many");
  });

  it("keeps hidden headings anchored but omits them from the contents", () => {
    const html = renderMarkdown("## Start\n\n" + fold("## Hidden\n\n" + fold("### Deeper"), "More", 4) + "\n\n## End", { idPrefix: "p-1-" });
    expect(html).toContain('id="p-1-h-2"');
    expect(readingInfo(html, "en").headings).toEqual([{ id: "p-1-h-1", depth: 2, text: "Start" }, { id: "p-1-h-4", depth: 2, text: "End" }]);
    expect(proseOf(fold("Visible to language detection and embeddings."))).toContain("Visible to language detection and embeddings.");
  });

  it("preserves opaque source when the editor serializes a changed surrounding paragraph", () => {
    const source = "::::details[**Title**]\n\nA  line.\n\n:::details[Inner]\nInner body.\n:::\n\n::::";
    const processor = remarkCtx.create(new Map()).get()().use(remarkMarkdownRules);
    const tree = processor.parse(source + "\n\nAfter");
    expect(String(processor.stringify(tree))).toContain(source);
    expect(createMarkdownProcessor().parse(source)).toMatchObject({ children: [{ type: "containerDirective", data: { detailsSource: source } }] });
  });

  it.each([
    ":::unknown[Title]{open}\nBody\n:::",
    ":::details[Unclosed]\nBody",
    "- Item\n\n  :::details[Title]\n  Body\n  :::",
    "> :::details[Title]\n> Body\n> :::",
    "> :::details[Title]\n>Body\n> :::",
  ])("preserves opaque valid and literal containers in editor serialization: %s", source => {
    const processor = remarkCtx.create(new Map()).get()().use(remarkMarkdownRules).use(remarkEditorAttention).data("settings", EDITOR_STRINGIFY_OPTIONS);
    const tree = processor.parse(source);
    processor.runSync(tree, source);
    expect(String(processor.stringify(tree)).trimEnd()).toBe(source);
  });

  it("retains the enclosed prose for extraction and preserves export source", () => {
    const source = fold("An enclosed finding for search and embeddings.", "Conditions");
    expect(markdownToPlainText(source)).toContain("An enclosed finding for search and embeddings.");
    expect(offlineMarkdown(source, { page: "post.md", lang: "en", extension: "md", posts: new Map(), documents: new Set() })).toBe(source);
  });

  it("finds and decorates translated figures inside closed containers", () => {
    const id = "a".repeat(64);
    const html = renderMarkdown(fold(`![Figure](/media/${id}-10x10.webp)`));
    expect(figureImageIds(html)).toEqual([id]);
    const translated = decorateFigureHtml(html, html, new Map([[id, { hasImage: true, results: [] }]]), "ja");
    expect(translated).toContain(`<img src="${figurePath(id, 10, 10, "ja")}"`);
    expect(translated).toContain("<details>");
    expect(translated).not.toContain("<details open");
  });

  it("retains raw Markdown in stored posts and reports issues without rejecting publication", async () => {
    const db = await createTestDb();
    await addMember(db, "details-writer", "details_writer");
    const source = fold("Text for AI and exports.");
    const result = await createTopic(db, "details-writer", { lang: "en", body: source });
    if (!result.ok) throw new Error(result.error);
    expect((await db.select().from(entries).where(eq(entries.id, result.id)))[0].body).toBe(source);
    expect(await buildThreadMarkdown(db, result.id, { page: 1, lang: null, sentences: false, k: null, readerId: "details-writer" })).toContain(source);
    const invalid = ":::unsupported[Title]\nContent\n:::";
    const issues = await checkDraftIssues(db, { kind: "topic", lang: "en", body: invalid, authorId: "details-writer" });
    expect(issues.issues).toMatchObject([{ kind: "details_literal", detailsReason: "name" }]);
    expect((await createTopic(db, "details-writer", { lang: "en", body: invalid })).ok).toBe(true);
  });
});

describe("translation details boundaries", () => {
  const source = "Before.\n\n" + fold("Inside.\n\n" + fold("Nested.", "Inner"), "Outer", 4) + "\n\nAfter.";
  it("accepts translated summaries and bodies at the same boundaries", () => {
    expect(checkStructure(source, source.replaceAll("Before", "Avant").replaceAll("Inside", "Dedans").replaceAll("Nested", "Imbriqué").replaceAll("After", "Après").replaceAll("Inner", "Intérieur").replaceAll("Outer", "Extérieur")).ok).toBe(true);
  });
  it.each([
    source.replace("\n:::\n::::\n\nAfter.", "\n:::\n\nAfter.\n::::"),
    source.replace(":::details[Inner]\n", "").replace("Nested.\n:::", "Nested."),
    "Before.\n\n" + fold("Inside.", "Outer") + "\n\n" + fold("Nested.", "Inner") + "\n\nAfter.",
    source.replace("\n::::\n", "\n"),
    source.replace("::::details[Outer]", "::::details[Outer]{open}"),
  ])("hides boundary, count, nesting and validity changes: %s", translated => {
    const result = checkStructure(source, translated);
    expect(result.ok).toBe(false);
    expect(result.flags).toContain(FLAG_STRUCTURE_MISMATCH);
    expect(result.flags).toContain(FLAG_QUALITY_MISMATCH);
    expect(result.flags.some(flag => HIDDEN_PRIMARY_FLAGS.includes(flag))).toBe(true);
  });
  it("retries a moved boundary and withholds an output that still differs", async () => {
    const engine = { ...createFakeEngine(), translate: vi.fn(async () => ({ text: source.replace("\n::::\n", "\n"), model: "fixture", promptVersion: "fixture", inputTokens: 1, outputTokens: 1 })) };
    const result = await translateChecked(engine, { text: source, from: "en", to: "fr" });
    expect(result.attempts).toBe(2);
    expect(isUsablePrimary({ sourceHash: "source", flags: result.flags }, "source")).toBe(false);
  });
});
