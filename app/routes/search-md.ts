import type { Route } from "./+types/search-md";
import { errorResponse, guarded, memberResponse, methodNotAllowed } from "~/lib/api/http.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { combinedSearch } from "~/lib/combined-search.server";
import { buildSearchMarkdown } from "~/lib/md/search.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { checkQuery, MAX_QUERY_LENGTH } from "~/lib/search";
import { resolveDisplayLang } from "~/lib/display";

// /search.md and /search.txt: Markdown search results (?q=; ?lang= overrides the stored default for translated titles and excerpts). Read authentication matches other Markdown endpoints
// (Cookie, read token, ?k=). Query embeddings cost money, so also apply the UI's per-member limit of 60 searches per hour,
// separate from the token read limit of 600 per hour. Empty or overlong queries return 400; unavailable semantics leaves literal results.
export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "search-md", async () => {
    const authed = await authenticateRead(request, "text");
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const params = new URL(request.url).searchParams;
    const lang = params.get("lang");
    if (lang !== null && !isEnabledLang(lang)) return errorResponse(request, "text", 400, "invalid_lang", `?lang= must be one of the languages of this site: ${enabledLangs().join(", ")}.`);
    const checked = checkQuery(params.get("q"));
    if (!checked.ok) {
      return checked.error === "empty"
        ? errorResponse(request, "text", 400, "missing_query", "Give the search text in ?q=.")
        : errorResponse(request, "text", 400, "query_too_long", `?q= can be at most ${MAX_QUERY_LENGTH} characters.`);
    }
    const rate = await hitMemberLimit(auth.db, "search", auth.userId);
    if (!rate.allowed) {
      return errorResponse(request, "text", 429, "rate_limited", `Too many searches. Try again in ${rate.retryAfterSeconds} seconds.`, rateLimitHeaders(rate));
    }
    const displayLang = resolveDisplayLang({ query: lang, profile: auth.profile, uiLocale: auth.profile.uiLocale, enabled: enabledLangs() });
    const result = await combinedSearch(auth.db, checked.query, { displayLang, readLangs: lang ? [] : auth.profile.readLangs });
    return memberResponse(request, await buildSearchMarkdown(auth.db, checked.query, result.found, {
      lang: displayLang, k: auth.carryK, search: { literalOnly: result.literalOnly },
    }), { rate });
  });
}
