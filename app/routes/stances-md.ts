import type { Route } from "./+types/stances-md";
import { guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { distributionViewerFor } from "~/lib/distribution.server";
import { buildStancesMarkdown } from "~/lib/md/stances.server";
import { parseIdOrNull } from "~/lib/params.server";

// /t/:id/stances.md and /t/:id/stances.txt: question distributions, totals and number of respondent languages only, without per-language counts. Read authentication matches Markdown endpoints (Cookie, read token,
// or signed link, all requiring an active member; app/lib/api/read-auth.server.ts), with read rate limits. Cache-Control: private, no-store. Return before stance selection, treating retrieval as the explicit 「先に結果を見る」
// action. Omit the viewer's own stance. No stance-writing API exists; registration and changes use browser /stance only.
export async function loader({ request, params }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "md-stances", async () => {
    const authed = await authenticateRead(request, "text");
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const id = parseIdOrNull(params.id);
    if (id === null) return notFound(request, "text");
    const markdown = await buildStancesMarkdown(auth.db, id, distributionViewerFor({ userId: auth.userId, profile: auth.profile }));
    return markdown === null ? notFound(request, "text") : memberResponse(request, markdown, { rate: auth.rate });
  });
}
