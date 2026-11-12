import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as renderer from "~/lib/markdown.core.server";
import * as mentions from "~/lib/mentions-md.core.server";
import * as references from "~/lib/entry-references.core.server";
import * as plain from "~/lib/plain-text.core.server";
import * as structure from "~/lib/llm/structure.core.server";
import * as copy from "~/lib/llm/copy-detection.core.server";
import * as frontmatter from "~/lib/entry-frontmatter.core.server";
import * as evaluation from "~/lib/eval/checks.core.server";
import * as language from "~/lib/lang-detect.core.server";

it("keeps body interpretation out of the caller's module instances", async () => {
  const spies = [
    vi.spyOn(renderer, "renderMarkdown"), vi.spyOn(mentions, "mentionSpellings"),
    vi.spyOn(references, "parseEntryReferences"), vi.spyOn(plain, "markdownToPlainText"),
    vi.spyOn(structure, "checkStructure"), vi.spyOn(copy, "detectCopy"), vi.spyOn(frontmatter, "parseMapping"),
    vi.spyOn(evaluation, "deterministicCheck"),
    vi.spyOn(language, "detectLang"),
  ];
  try {
    const source = "# A post\n\n**Evidence** and @hana [topic](/t/1), with $x^2$.\n";
    await (await import("~/lib/markdown.server")).renderMarkdown(source);
    await (await import("~/lib/mentions-md.server")).mentionSpellings(source);
    await (await import("~/lib/entry-references.server")).parseEntryReferences(source);
    await (await import("~/lib/plain-text.server")).markdownToPlainText(source);
    await (await import("~/lib/llm/structure.server")).checkStructure(source, source);
    await (await import("~/lib/llm/copy-detection.server")).detectCopy(source, source, "en", "ja");
    await (await import("~/lib/entry-frontmatter.server")).parseMapping("type: topic\ntitle: Test");
    await (await import("~/lib/eval/checks.server")).deterministicCheck({ id: "C1", kind: "markdown", description: "Preserve markup" }, source, source, false);
    expect(await (await import("~/lib/lang-detect")).detectLang("確認", "ja")).toBe("ja");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { for (const spy of spies) spy.mockRestore(); }
});

it("does not let request modules construct their own Markdown parser", () => {
  const files = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === "paraglide" ? [] : files(path.join(directory, entry.name))) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
  const violations = files("app").filter(file => !file.includes(".core.server.") && !file.includes(".client.") && file !== "app/lib/markdown-rules.ts")
    .filter(file => /import[^;]*\bcreateMarkdownProcessor\b[^;]*from/.test(fs.readFileSync(file, "utf8")));
  expect(violations).toEqual([]);
});
