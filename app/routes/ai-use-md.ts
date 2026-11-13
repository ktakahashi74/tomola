import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { errorResponse, guarded, methodNotAllowed, publicResponse } from "~/lib/api/http.server";
import { aiUseMarkdown, aiUsePage } from "~/lib/ai-use-page.server";
import { isLang } from "~/lib/languages";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import type { Route } from "./+types/ai-use-md";

export function loader({ request }: Route.LoaderArgs) {
  return guarded(request, "text", "ai-use-md", async () => {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
    const locale = new URL(request.url).searchParams.get("lang") ?? "en";
    if (!isLang(locale)) return errorResponse(request, "text", 400, "invalid_lang", "Unknown language tag.");
    const body = mdBlock({ type: "page", id: "ai-use", lang: locale, canonical: siteUrl("/ai-use") }, aiUseMarkdown(aiUsePage(locale)));
    const response = publicResponse(request, body, GUIDE_CONTENT_TYPE);
    response.headers.set("X-Robots-Tag", "noindex");
    response.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return response;
  });
}
