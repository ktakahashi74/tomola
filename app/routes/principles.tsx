import { decorateDocumentFigures } from "~/lib/figure-display.server";
import { toggleFigure } from "~/lib/figure";
export { mathLinks as links } from "~/lib/math-style";
import { initializeSiteMarkdown } from "~/lib/markdown-startup.server";
import { DocumentHeader } from "~/components/document-header";
import { DocumentLanguages } from "~/components/document-languages";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { ReadingToc } from "~/components/reading-toc";
import { PublicDocumentEnd } from "~/components/public-document-end";
import type { Route } from "./+types/principles";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { principlesDirection, principlesLanguageGroups, type PrinciplesLang } from "~/lib/principles-languages";
import { isPrinciplesLang, principlesFor, renderPrinciples } from "~/lib/principles.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

// /principles: the principles page. Public: readable without logging in, outside the member layout, and it reads no session. Canonical prose needs no database; optional managed figures use the same image visibility checks as other pages.
// The supplied texts in app/content/principles/ follow the screen language or any supported ?lang= tag. Japanese is the original; each translation has its own review status.
// The HTML is not kept by shared caches: the root middleware gives every HTML response a private, no-cache policy in production, and Vary: Accept-Language, Cookie.
export async function loader({ request }: Route.LoaderArgs) {
  await initializeSiteMarkdown();
  const asked = new URL(request.url).searchParams.get("lang");
  // All principles editions are available; an unknown tag falls back to the screen language.
  const requested: PrinciplesLang = isPrinciplesLang(asked) ? asked : (getLocale() as PrinciplesLang);
  const view = principlesFor(requested);
  const rendered = await renderPrinciples(view.document);
  const page = view.document.lang === "ja" ? rendered : await decorateDocumentFigures(rendered, () => renderPrinciples(principlesFor("ja").document), view.document.lang);
  // The contents list is made from the section headings ("## 1. …"); the section ids s1 … s7 are the anchors.
  const headings = view.document.sections.map(section => ({ id: section.id, depth: 2 as const, text: section.markdown.split("\n")[0].replace(/^##\s+/, "").trim() }));
  return { requested: view.requested, shown: view.document.lang, status: view.status, page, headings, languages: principlesLanguageGroups(enabledLangs()) };
}

// The page is public but not indexable, like /ai.txt (which disallows indexing): a header and a robots meta, so that neither a crawler of the HTML nor one of the .md is told to keep it.
export function headers() {
  return { "X-Robots-Tag": "noindex" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  // The twin matches the document language, independently of the interface language.
  const shown = loaderData?.shown ?? "ja";
  const twin = shown === "ja" ? "/principles.md" : `/principles.md?lang=${shown}`;
  return [{ title: m.principles_title() }, { name: "robots", content: "noindex" }, { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: twin }];
}

export default function Principles({ loaderData }: Route.ComponentProps) {
  const { shown, page, languages, headings } = loaderData;
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    body?.addEventListener("click", toggleFigure);
    return () => body?.removeEventListener("click", toggleFigure);
  }, []);
  return (
    <>
    <DocumentHeader showWhyLink />
    <main className="reading-column space-y-6">
      {/* The languages you can join in stay on one line; the rest are one fold away (open when the page is shown in one of them). */}
      <DocumentLanguages path="/principles" shown={shown} languages={languages} />
      <p className="ui-meta"><Link to="/languages" className="underline">{m.languages_other()}</Link></p>
      {shown !== "ja" && (
        <p>
          <Link to="/principles?lang=ja" className="underline">{m.principles_original_link()}</Link>
        </p>
      )}
      <ReadingToc headings={headings} lang={shown} bodyRef={bodyRef} />
      <article ref={bodyRef} lang={shown} dir={principlesDirection(shown)} className="space-y-6">
        <h1 className="reading-title">{page.title}</h1>
        <div className="longread" dangerouslySetInnerHTML={{ __html: page.introHtml }} />
        {page.sections.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-4">
            {/* The names that other pages link to (/principles#rules, /principles#objections). */}
            {section.alias && <span id={section.alias} />}
            <div className="longread" dangerouslySetInnerHTML={{ __html: section.html }} />
          </section>
        ))}
      </article>
      <PublicDocumentEnd />
    </main>
    </>
  );
}
