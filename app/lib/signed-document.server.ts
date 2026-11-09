import { stripLeadingComments } from "~/lib/principles.server";
import { renderMarkdown } from "~/lib/markdown.server";

export type SignedDocument<L extends string> = { lang: L; markdown: string; title: string; bodyHtml: string };

// Fixed signed documents share parsing, language fallback and explicit startup
// rendering. Importing their source text never starts a Markdown worker.
// Japanese is the original; the other texts are translations and say so in their
// first paragraph until someone checks them.
export function createSignedDocuments<L extends string>(name: string, sources: Record<L, string>, fallback: L) {
  const languages = Object.keys(sources) as L[];
  const documents = {} as Record<L, SignedDocument<L>>;
  const isLanguage = (value: unknown): value is L => typeof value === "string" && Object.hasOwn(sources, value);
  for (const lang of languages) {
    const markdown = stripLeadingComments(sources[lang]);
    const first = markdown.split(/\r?\n/, 1)[0];
    if (!first?.startsWith("# ")) throw new Error(`${name} ${lang}: the text must start with a "# " title`);
    documents[lang] = { lang, markdown, title: first.slice(2).trim(), bodyHtml: "" };
  }
  return {
    id: name,
    languages,
    isLanguage,
    // Asked language, then screen language, then the document's fallback.
    forLanguage(asked: string | null, screen: string): SignedDocument<L> {
      return documents[isLanguage(asked) ? asked : isLanguage(screen) ? screen : fallback];
    },
    async initialize(): Promise<void> {
      for (const lang of languages) {
        const [, ...body] = documents[lang].markdown.split(/\r?\n/);
        documents[lang].bodyHtml = await renderMarkdown(body.join("\n").trim(), { lang });
      }
    },
  };
}
