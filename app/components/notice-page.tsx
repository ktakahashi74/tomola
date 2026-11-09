import { Link } from "react-router";
import { DocumentHeader } from "~/components/document-header";
import { PRINCIPLES_LANG_LABELS } from "~/lib/principles-languages";
import type { loadNotice } from "~/lib/notice-route.server";
import { m } from "~/paraglide/messages.js";

type NoticeData = Awaited<ReturnType<typeof loadNotice>>;
export function NoticePage({ page }: { page: NoticeData }) {
  return <><DocumentHeader /><main className="reading-column space-y-6">
    <nav aria-label={m.principles_langs_label()} className="ui-meta"><ul className="flex gap-3">
      {(["ja", "en"] as const).map(lang => <li key={lang}>{lang === page.lang ? <span lang={lang} aria-current="page" className="font-bold">{PRINCIPLES_LANG_LABELS[lang]}</span> : <Link to={`/${page.kind}?lang=${lang}`} lang={lang} className="underline">{PRINCIPLES_LANG_LABELS[lang]}</Link>}</li>)}
    </ul></nav>
    {page.fallback && <p role="note">{m.notice_language_fallback()}</p>}
    {page.lang !== "ja" && <p><Link className="underline" to={`/${page.kind}?lang=ja`}>{m.principles_original_link()}</Link></p>}
    <article lang={page.lang} className="space-y-6">
      <h1 className="reading-title">{page.title}</h1>
      <div className="longread" dangerouslySetInnerHTML={{ __html: page.introHtml }} />
      {page.sections.map(section => <section key={section.id} id={section.id} className="longread" dangerouslySetInnerHTML={{ __html: section.html }} />)}
    </article>
  </main></>;
}
export function noticeMeta(page: NoticeData | undefined) {
  return [{ title: page?.title ?? "tomola" }, { name: "robots", content: "noindex" }, ...(page ? [{ tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/${page.kind}.md?lang=${page.lang}` }] : [])];
}
