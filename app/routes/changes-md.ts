import type { Route } from "./+types/changes-md";
import { errorResponse, guarded, memberResponse, methodNotAllowed } from "~/lib/api/http.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { buildChangesMarkdown, defaultSince, parseCursor, parseSince } from "~/lib/md/changes.server";

// /changes.md and /changes.txt: changes feed (?since=<ISO timestamp>, default seven days ago; invalid values return 400. ?cursor=<timestamp>_<id> returns entries after that position; invalid values return 400.
// When cursor is present without since, do not apply the seven-day default).
// Read authentication (Cookie, read Bearer token, ?k=) matches Markdown endpoints (app/lib/api/read-auth.server.ts).
export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  // Unexpected exceptions return a plain-text 500 rather than an HTML error page.
  return guarded(request, "text", "changes", async () => {
    const authed = await authenticateRead(request, "text");
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const params = new URL(request.url).searchParams;
    const rawSince = params.get("since");
    const rawCursor = params.get("cursor");
    const parsedSince = rawSince === null ? null : parseSince(rawSince);
    if (rawSince !== null && parsedSince === null) return errorResponse(request, "text", 400, "invalid_since", "?since= must be an ISO 8601 date or time with a time zone, for example 2026-10-01T00:00:00Z.");
    const cursor = rawCursor === null ? null : parseCursor(rawCursor);
    if (rawCursor !== null && cursor === null) return errorResponse(request, "text", 400, "invalid_cursor", "?cursor= must be a cursor from a previous response (next_cursor), for example 2026-10-01T00:20:00.000Z_12.");
    // Default to seven days ago when neither since nor cursor is present.
    const since = parsedSince ?? (cursor === null ? defaultSince() : null);
    return memberResponse(request, await buildChangesMarkdown(auth.db, { since, cursor, k: auth.carryK }), { rate: auth.rate });
  });
}
