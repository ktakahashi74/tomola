import type { Route } from "./+types/languages-md";
import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { errorResponse, methodNotAllowed, publicResponse } from "~/lib/api/http.server";
import { languagePage, languagePageMarkdown } from "~/lib/language-page.server";
import { isLang } from "~/lib/languages";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";

// Public Markdown twin. English by default for machine readers, with an explicit translated edition.
export function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  const locale = new URL(request.url).searchParams.get("lang") ?? "en";
  if (!isLang(locale)) return errorResponse(request, "text", 400, "invalid_lang", "Unknown language tag.");
  const body = mdBlock({ type: "page", id: "languages", lang: locale, canonical: siteUrl("/languages") }, languagePageMarkdown(languagePage(locale)));
  const response = publicResponse(request, body, GUIDE_CONTENT_TYPE);
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
