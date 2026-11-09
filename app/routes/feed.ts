import type { Route } from "./+types/feed";
import { authenticatePageRead } from "~/lib/api/page-read-auth.server";
import { errorResponse, guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { rssXml } from "~/lib/feed-xml";
import { buildFeed, type FeedScope } from "~/lib/feeds.server";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import type { Lang } from "~/lib/languages";
import { rateLimitHeaders } from "~/lib/rate-limit.server";
import { publicReading } from "~/lib/public-reading.server";
import { villageBySlug } from "~/lib/villages.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";

// RSS feeds without login: /feed.xml (the whole site) and /v/:slug/feed.xml (one village). The two routes share this module and are told apart by
// their params. Only topics a reader who has not logged in may read; nothing at all while the site is closed to such readers. Read counts and headers are those of the Markdown twins.
export async function loader({ request, params }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  if (!publicReading()) return notFound(request, "text");
  if (params.slug !== undefined && !villagesEnabled()) return notFound(request, "text");
  return guarded(request, "text", "feed", async () => {
    // The read limit comes first, as for the other public reads: a request with a wrong ?lang= counts too.
    const authed = await authenticatePageRead(request);
    if (!authed.ok) return authed.response;
    const { db, rate } = authed.auth;
    const langParam = new URL(request.url).searchParams.get("lang");
    if (langParam !== null && !isEnabledLang(langParam)) return errorResponse(request, "text", 400, "invalid_lang", `?lang= must be one of the languages of this site: ${enabledLangs().join(", ")}.`, rate ? rateLimitHeaders(rate) : {});
    const lang = langParam as Lang | null;
    let scope: FeedScope = { kind: "all" };
    let selfPath = "/feed.xml";
    if (params.slug !== undefined) {
      const village = await villageBySlug(db, params.slug);
      // An ended village will have nothing new.
      if (!village?.slug || village.endedAt !== null) return notFound(request, "text");
      scope = { kind: "village", village };
      selfPath = `/v/${village.slug}/feed.xml`;
    }
    const feed = await buildFeed(db, scope, lang, selfPath);
    return memberResponse(request, rssXml(feed), { rate, headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
  });
}
