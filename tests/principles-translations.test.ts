import fs from "node:fs";
import { expect, it } from "vitest";
import { PRINCIPLES_LANGS } from "~/lib/principles-languages";
import { parsePrinciples } from "~/lib/principles.server";

it.each(PRINCIPLES_LANGS.filter(lang => lang !== "ja"))("the supplied %s principles keep the original's section and list structure", lang => {
  const raw = fs.readFileSync(`app/content/principles/${lang}.md`, "utf8");
  const original = parsePrinciples(fs.readFileSync("app/content/principles/ja.md", "utf8"), "ja");
  const document = parsePrinciples(raw, lang);
  expect(document.title).not.toBe("");
  expect(document.sections.map(section => section.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const counts = (sections: typeof document.sections) => sections.map(section => section.markdown.split("\n").filter(line => line.startsWith("- ")).length);
  expect(counts(document.sections)).toEqual(counts(original.sections));
  const boldCount = (markdown: string) => (markdown.match(/\*\*[^*]+\*\*/g) ?? []).length;
  expect(boldCount(document.markdown)).toBe(boldCount(original.markdown));
});
