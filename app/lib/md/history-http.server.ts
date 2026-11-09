import { guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { authenticatePageRead } from "~/lib/api/page-read-auth.server";
import { buildHistoryMarkdown } from "~/lib/md/history.server";
import { parseIdOrNull } from "~/lib/params.server";

export async function serveHistoryMarkdown(request: Request, stem: string | undefined, version?: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "md-history", async () => {
    const authed = await authenticatePageRead(request);
    if (!authed.ok) return authed.response;
    const id = parseIdOrNull(stem);
    if (id === null) return notFound(request, "text");
    const { auth } = authed;
    const text = await buildHistoryMarkdown(auth.db, id, version, auth.profile?.userId ?? null, auth.carryK, new URL(request.url).pathname.startsWith("/c/") ? "reply" : "topic");
    return text === null ? notFound(request, "text") : memberResponse(request, text, { rate: auth.rate });
  });
}
