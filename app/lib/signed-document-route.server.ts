import type { SignedDocumentPageData } from "~/components/signed-document";
import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { errorResponse, guarded, methodNotAllowed, publicResponse } from "~/lib/api/http.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { initializeSiteMarkdown } from "~/lib/markdown-startup.server";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import { principlesLanguageGroups, type PrinciplesLang } from "~/lib/principles-languages";
import type { SignedDocument } from "~/lib/signed-document.server";
import { getLocale } from "~/paraglide/runtime.js";

type SignedDocuments = {
  id: string;
  languages: readonly PrinciplesLang[];
  isLanguage: (value: unknown) => boolean;
  forLanguage: (asked: string | null, screen: string) => SignedDocument<PrinciplesLang>;
};

// Public fixed documents read neither the session nor the database.
export async function loadSignedDocument(request: Request, documents: SignedDocuments): Promise<SignedDocumentPageData> {
  await initializeSiteMarkdown();
  const doc = documents.forLanguage(new URL(request.url).searchParams.get("lang"), getLocale());
  return { shown: doc.lang, title: doc.title, bodyHtml: doc.bodyHtml, languages: principlesLanguageGroups(enabledLangs(), documents.languages) };
}

// Markdown defaults to the Japanese original; invalid explicit languages are errors.
export function signedDocumentMarkdownResponse(request: Request, documents: SignedDocuments) {
  return guarded(request, "text", `md-${documents.id}`, async () => {
    await initializeSiteMarkdown();
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
    const asked = new URL(request.url).searchParams.get("lang");
    if (asked !== null && !documents.isLanguage(asked)) {
      return errorResponse(request, "text", 400, "invalid_lang", `?lang= must be one of: ${documents.languages.join(", ")}.`);
    }
    const doc = documents.forLanguage(asked ?? "ja", "ja");
    const fields = {
      type: "page",
      id: documents.id,
      lang: doc.lang,
      canonical: siteUrl(`/${documents.id}`),
      original: doc.lang === "ja" ? undefined : siteUrl(`/${documents.id}.md`),
    };
    const response = publicResponse(request, mdBlock(fields, doc.markdown), GUIDE_CONTENT_TYPE);
    response.headers.set("X-Robots-Tag", "noindex");
    return response;
  });
}
