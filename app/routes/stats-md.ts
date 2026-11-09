import { authenticatePageRead } from "~/lib/api/page-read-auth.server";
import { guarded, memberResponse, methodNotAllowed } from "~/lib/api/http.server";
import { readPublicStats } from "~/lib/public-stats.server";
import { publicStatsMarkdown } from "~/lib/public-stats-view";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import { getLocale } from "~/paraglide/runtime.js";

export function loader({ request }: { request: Request }) {
  return guarded(request, "text", "stats-md", async () => {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
    const result = await authenticatePageRead(request);
    if (!result.ok) return result.response;
    const stats = await readPublicStats(result.auth.db);
    return memberResponse(request, mdBlock({ type: "page", id: "stats", lang: getLocale(), canonical: siteUrl("/stats"), generated_at: stats.generatedAt }, publicStatsMarkdown(stats)), { rate: result.auth.rate });
  });
}
