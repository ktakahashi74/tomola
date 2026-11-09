import { operatorDocument } from "~/lib/operator-config.server";
import enSource from "~/content/principles/en.md?raw";
import jaSource from "~/content/principles/ja.md?raw";
import frSource from "~/content/principles/fr.md?raw";
import deSource from "~/content/principles/de.md?raw";
import zhHantSource from "~/content/principles/zh-Hant.md?raw";
import zhHansSource from "~/content/principles/zh-Hans.md?raw";
import koSource from "~/content/principles/ko.md?raw";
import thSource from "~/content/principles/th.md?raw";
import viSource from "~/content/principles/vi.md?raw";
import esSource from "~/content/principles/es.md?raw";
import ptSource from "~/content/principles/pt.md?raw";
import ruSource from "~/content/principles/ru.md?raw";
import arSource from "~/content/principles/ar.md?raw";
import hiSource from "~/content/principles/hi.md?raw";
import idSource from "~/content/principles/id.md?raw";
import bnSource from "~/content/principles/bn.md?raw";
import urSource from "~/content/principles/ur.md?raw";
import { PRINCIPLES_LANGS, type PrinciplesLang } from "~/lib/principles-languages";
import { renderMarkdown } from "~/lib/markdown.server";

// The principles page (/principles and /principles.md) reads its seventeen canonical texts from app/content/principles/.
// Leading HTML comments hold notes that are excluded from every public response. Japanese is the original;
// each translation records its review status in its own text. Tests compare structure with the Japanese source.

export type PrinciplesStatus = "original" | "unverified" | "human_checked";

// The page has seven sections (## 1. … ## 7. …), whose heading ids are s1 … s7. Two of them also have a name that other pages link to: the rules for ordering and counting (section 3)
// are #rules, and how to object (section 7) is #objections.
export const SECTION_COUNT = 7;
export const SECTION_ALIASES: Readonly<Record<number, string>> = { 3: "rules", 7: "objections" };

export type PrinciplesSection = { number: number; id: string; alias: string | null; markdown: string };

export type PrinciplesDocument = {
  lang: PrinciplesLang;
  // The text as it is published, without the leading HTML comments.
  markdown: string;
  title: string;
  // The text between the title and the first section.
  intro: string;
  sections: PrinciplesSection[];
};

const LEADING_COMMENTS = /^(?:\s*<!--[\s\S]*?-->\s*)+/;

export function stripLeadingComments(raw: string): string {
  return raw.replace(LEADING_COMMENTS, "");
}

function hasUnverifiedMarker(markdown: string): boolean {
  const first = markdown.split(/\r?\n/).slice(1).find(line => line.trim() !== "");
  return first?.trim().toLowerCase() === "unverified machine translation";
}

// Splits a principles text into its title, the introduction and the numbered sections. Throws when the text does not have the shape the page relies on
// (a title, and sections numbered 1 to 7 in order), so that a broken edit fails the tests and the build of the page, not a reader.
export function parsePrinciples(raw: string, lang: PrinciplesLang): PrinciplesDocument {
  const markdown = stripLeadingComments(raw);
  const lines = markdown.split(/\r?\n/);
  if (!lines[0]?.startsWith("# ")) throw new Error(`principles ${lang}: the text must start with a "# " title`);
  if (lang === "ja" && hasUnverifiedMarker(markdown)) throw new Error("principles ja: the original cannot have an unverified translation marker");
  const title = lines[0].slice(2).trim();
  const starts: Array<{ line: number; number: number }> = [];
  lines.forEach((line, index) => {
    const match = /^## (\d+)\. /.exec(line);
    if (match) starts.push({ line: index, number: Number(match[1]) });
  });
  if (starts.length !== SECTION_COUNT || starts.some((s, i) => s.number !== i + 1)) {
    throw new Error(`principles ${lang}: expected sections numbered 1 to ${SECTION_COUNT} in order, found ${starts.map((s) => s.number).join(", ") || "none"}`);
  }
  const intro = lines.slice(1, starts[0].line).join("\n").trim();
  const sections = starts.map((start, i) => ({
    number: start.number,
    id: `s${start.number}`,
    alias: SECTION_ALIASES[start.number] ?? null,
    markdown: lines.slice(start.line, starts[i + 1]?.line ?? lines.length).join("\n").trim(),
  }));
  return { lang, markdown, title, intro, sections };
}

const sources: Record<PrinciplesLang, string> = { ja: jaSource, en: enSource, fr: frSource, de: deSource, "zh-Hant": zhHantSource, "zh-Hans": zhHansSource, ko: koSource, th: thSource, vi: viSource, es: esSource, pt: ptSource, ru: ruSource, ar: arSource, hi: hiSource, id: idSource, bn: bnSource, ur: urSource };
const documents = new Map<PrinciplesLang, PrinciplesDocument>();

// Review is recorded in the text itself. Remove this first paragraph only after checking a translation against the original.
export function principlesStatus(document: PrinciplesDocument): PrinciplesStatus {
  if (document.lang === "ja") return "original";
  return hasUnverifiedMarker(document.markdown) ? "unverified" : "human_checked";
}

// Principles translations are public in every supported language, independently of the site's enabled posting/UI languages.
export function principlesLangs(): PrinciplesLang[] {
  return [...PRINCIPLES_LANGS];
}

export function isPrinciplesLang(x: unknown): x is PrinciplesLang {
  return typeof x === "string" && (principlesLangs() as readonly string[]).includes(x);
}

export type PrinciplesView = {
  // The language the reader asked for.
  requested: PrinciplesLang;
  // The text in the requested language.
  document: PrinciplesDocument;
  status: PrinciplesStatus;
};

export function principlesFor(requested: PrinciplesLang): PrinciplesView {
  let document = documents.get(requested);
  if (!document) {
    // Keep the operator paragraph at the start of the governance section.
    const markdown = sources[requested]
      .replace(/\{\{(principles-rules-status|principles-objections-contact)\}\}/g, (_marker, kind: "principles-rules-status" | "principles-objections-contact") => operatorDocument(kind, requested).trim())
      .replace(/^(## 6\. .*\n\n)/m, heading => `${heading}${operatorDocument("principles-footer", requested).trimEnd()}\n`);
    document = parsePrinciples(markdown, requested);
    documents.set(requested, document);
  }
  return { requested, document, status: principlesStatus(document) };
}

// The first sentence of the principles in a language, as plain text, for places that show what tomola is in the reader's own language (the signup screen).
// `ai` is true while that text is an unchecked machine translation, which the caller says next to it.
export function principlesOpening(lang: PrinciplesLang): { text: string; ai: boolean } {
  const view = principlesFor(lang);
  const paragraph = view.document.intro.split(/\n\s*\n/).map(part => part.trim()).find(part => part && part.toLowerCase() !== "unverified machine translation") ?? "";
  const plain = paragraph.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "");
  const first = [...new Intl.Segmenter(lang, { granularity: "sentence" }).segment(plain)][0]?.segment.trim() ?? plain;
  return { text: first, ai: view.status === "unverified" };
}

export function principlesReviewStates(): string {
  return principlesLangs().map(lang => `${lang}: ${principlesFor(lang).status}`).join(", ");
}

export type RenderedPrinciples = {
  title: string;
  introHtml: string;
  sections: Array<{ id: string; alias: string | null; html: string }>;
};

const rendered = new WeakMap<PrinciplesDocument, RenderedPrinciples>();

// The page body as HTML, through the same safe pipeline as the posts (raw HTML is dropped, links and images follow the same rules). The text is fixed, so it is rendered once.
export async function renderPrinciples(document: PrinciplesDocument): Promise<RenderedPrinciples> {
  const cached = rendered.get(document);
  if (cached) return cached;
  const options = { lang: document.lang };
  const sections: RenderedPrinciples["sections"] = [];
  for (const section of document.sections) sections.push({ id: section.id, alias: section.alias, html: await renderMarkdown(section.markdown, options) });
  const result: RenderedPrinciples = {
    title: document.title,
    introHtml: (await renderMarkdown(document.intro, options)),
    sections,
  };
  rendered.set(document, result);
  return result;
}

export async function initializePrinciplesMarkdown(): Promise<void> {
  for (const lang of PRINCIPLES_LANGS) await renderPrinciples(principlesFor(lang).document);
}
