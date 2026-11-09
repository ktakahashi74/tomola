import { Link } from "react-router";
import { DocumentHeader } from "~/components/document-header";
import { DocumentLanguages } from "~/components/document-languages";
import { PublicDocumentEnd } from "~/components/public-document-end";
import { principlesDirection, type PrinciplesLang, type principlesLanguageGroups } from "~/lib/principles-languages";
import { m } from "~/paraglide/messages.js";

export type SignedDocumentPageData = {
  shown: PrinciplesLang;
  title: string;
  bodyHtml: string;
  languages: ReturnType<typeof principlesLanguageGroups>;
};

// Public but not indexable, like /principles.
export function signedDocumentHeaders() {
  return { "X-Robots-Tag": "noindex" };
}

export function signedDocumentMeta(path: string, loaderData: SignedDocumentPageData | undefined) {
  const shown = loaderData?.shown ?? "ja";
  const twin = shown === "ja" ? `${path}.md` : `${path}.md?lang=${shown}`;
  return [{ title: loaderData?.title ?? "tomola" }, { name: "robots", content: "noindex" }, { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: twin }];
}

export function SignedDocumentPage({ path, shown, title, bodyHtml, languages }: SignedDocumentPageData & { path: string }) {
  return (
    <>
      <DocumentHeader />
      <main className="reading-column space-y-6">
        <DocumentLanguages path={path} shown={shown} languages={languages} />
        {shown !== "ja" && (
          <p>
            <Link to={`${path}?lang=ja`} className="underline">{m.principles_original_link()}</Link>
          </p>
        )}
        <article lang={shown} dir={principlesDirection(shown)} className="space-y-6">
          {path === "/name" && <img src="/icons/logomark.svg" alt="" width={160} height={160} className="block" />}
          <h1 className="reading-title">{title}</h1>
          <div className="longread" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        </article>
        <PublicDocumentEnd />
      </main>
    </>
  );
}
