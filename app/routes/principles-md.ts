import type { Route } from "./+types/principles-md";
import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { errorResponse, methodNotAllowed, publicResponse } from "~/lib/api/http.server";
import type { PrinciplesLang } from "~/lib/principles-languages";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import { isPrinciplesLang, principlesFor, principlesLangs } from "~/lib/principles.server";

// /principles.md and /principles.txt: the Markdown twin of the principles page. Public (no token), with the same headers as /llms.txt. The text is the same as the page's
// (app/content/principles/), without the source comment. Unlike the HTML page it does not follow the screen language: the original (Japanese) is the default, and ?lang=<tag>
// asks for its own translated text, even if its language is not enabled for posting or the interface.
// Frontmatter: type: page, id: principles, lang (the language of the text), status (original | human_checked | unverified), canonical (the page; never with ?lang=).
export function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  const asked = new URL(request.url).searchParams.get("lang");
  if (asked !== null && !isPrinciplesLang(asked)) {
    return errorResponse(request, "text", 400, "invalid_lang", `?lang= must be one of the principles languages: ${principlesLangs().join(", ")}.`);
  }
  const requested: PrinciplesLang = asked ?? "ja";
  const view = principlesFor(requested);
  const fields = {
    type: "page",
    id: "principles",
    lang: view.document.lang,
    status: view.status,
    canonical: siteUrl("/principles"),
    // The Japanese original, for every text that is not the original itself.
    original: view.document.lang === "ja" ? undefined : siteUrl("/principles.md"),
  };
  const response = publicResponse(request, mdBlock(fields, view.document.markdown), GUIDE_CONTENT_TYPE);
  // Public, but not indexable, like /ai.txt.
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
