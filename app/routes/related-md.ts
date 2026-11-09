import type { Route } from "./+types/related-md";
import { errorResponse, guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { authenticatePageRead } from "~/lib/api/page-read-auth.server";
import { resolveDisplayLang } from "~/lib/display";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { buildRelatedMarkdown } from "~/lib/md/related.server";
import { parsePageParam } from "~/lib/pagination";
import { parseIdOrNull } from "~/lib/params.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "md-related", async () => {
    const authed = await authenticatePageRead(request);
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const query = new URL(request.url).searchParams;
    const id = parseIdOrNull(params.id), page = parsePageParam(query.get("page"));
    if (id === null || page === null) return notFound(request, "text");
    const selected = query.get("lang");
    if (selected !== null && selected !== "all" && !isEnabledLang(selected)) return errorResponse(request, "text", 400, "invalid_lang", "Invalid display language.");
    const lang = resolveDisplayLang({ query: selected === "all" ? null : selected, profile: auth.profile ?? { displayLang: null, readLangs: [] }, uiLocale: auth.profile?.uiLocale, enabled: enabledLangs() });
    const markdown = await buildRelatedMarkdown(auth.db, id, { page, lang, linkLang: selected === "all" ? "all" : lang, readLangs: auth.profile?.readLangs ?? [], k: auth.carryK });
    return markdown === null ? notFound(request, "text") : memberResponse(request, markdown, { rate: auth.rate });
  });
}
