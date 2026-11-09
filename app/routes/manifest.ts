import type { Route } from "./+types/manifest";
import { errorResponse, guarded, memberResponse, methodNotAllowed } from "~/lib/api/http.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { buildManifest } from "~/lib/md/manifest.server";
import { parseIdOrNull } from "~/lib/params.server";

// /manifest.json: Markdown URL, last update time, and content hash for each published topic (?after=<topic-id> continues the list).
export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "json", "GET, HEAD");
  // Unexpected exceptions return JSON 500 rather than an HTML error page.
  return guarded(request, "json", "manifest", async () => {
    const authed = await authenticateRead(request, "json");
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const raw = new URL(request.url).searchParams.get("after");
    const after = raw === null ? 0 : parseIdOrNull(raw);
    if (after === null) return errorResponse(request, "json", 400, "invalid_after", "?after= must be a topic id (a positive integer).");
    const manifest = await buildManifest(auth.db, { after, k: auth.carryK });
    return memberResponse(request, JSON.stringify(manifest, null, 2), { format: "json", rate: auth.rate });
  });
}
