import { Link } from "react-router";
import { DocumentHeader } from "~/components/document-header";
import { languagePage } from "~/lib/language-page.server";
import { getLocale } from "~/paraglide/runtime.js";
import type { Route } from "./+types/languages";

// Public language availability and requests; no session or member content is read here.
export function loader() {
  return languagePage(getLocale());
}

export function headers() {
  return { "X-Robots-Tag": "noindex" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData?.title ?? "tomola" },
    { name: "robots", content: "noindex" },
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/languages.md?lang=${loaderData?.locale ?? "en"}` },
  ];
}

export default function Languages({ loaderData: page }: Route.ComponentProps) {
  return <>
    <DocumentHeader />
    <main className="reading-column space-y-6">
      <h1 className="reading-title">{page.title}</h1>
      <p>{page.opening} <Link to="/principles#s2" className="underline">{page.principlesLabel}</Link></p>
      <section className="space-y-2" aria-labelledby="languages-writing"><h2 id="languages-writing" className="text-lg font-semibold">{page.writingTitle}</h2><p>{page.writingHelp}</p><p>{page.readingHelp}</p></section>
      {page.groups.filter(group => group.languages.length).map(group => <section key={group.id} aria-labelledby={`languages-${group.id}`} className="space-y-2">
        <h2 id={`languages-${group.id}`} className="text-lg font-semibold">{group.title}</h2>
        <ul className="space-y-1">
          {group.languages.map(lang => <li key={lang.tag}><bdi lang={lang.tag}>{lang.nativeName}</bdi> <span className="text-muted-foreground">— {lang.name}</span></li>)}
        </ul>
      </section>)}
      <section aria-labelledby="languages-request" className="space-y-2">
        <h2 id="languages-request" className="text-lg font-semibold">{page.requestTitle}</h2>
        <p>{page.requestHelp}</p>
        <a href={page.mailto} className="underline">{page.requestLabel}</a>
      </section>
    </main>
  </>;
}
