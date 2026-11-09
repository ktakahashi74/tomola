import type { Route } from "./+types/signing";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { issueSignedWrite, previewSignedWrite, SigningError, signingErrorResponse } from "~/lib/signing.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";

export function loader() { return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireMember(request);
  const rate = await hitMemberLimit(db, "signing", user.id);
  if (!rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "private, no-store" } });
  try {
    const body = await request.json() as { intent?: unknown; pathname?: unknown; fields?: unknown; previewHash?: unknown };
    if (typeof body.pathname !== "string" || !Array.isArray(body.fields) || body.fields.length > 100) throw new SigningError("invalid_payload", 400);
    const form = new FormData();
    for (const pair of body.fields) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string" || pair[0].length > 100 || pair[1].length > 150000) throw new SigningError("invalid_payload", 400);
      form.append(pair[0], pair[1]);
    }
    if (body.pathname !== "/settings/delete-account" || form.get("intent") !== "delete-account") await requireWriter(request);
    const result = body.intent === "preview" ? await previewSignedWrite(db, user.id, body.pathname, form)
      : body.intent === "challenge" && typeof body.previewHash === "string" ? await issueSignedWrite(db, user.id, body.pathname, form, body.previewHash)
      : (() => { throw new SigningError("invalid_payload", 400); })();
    return Response.json(result, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    if (error instanceof MarkdownBusyError) return Response.json({ error: "rate_limited" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    if (error instanceof SigningError) return signingErrorResponse(error);
    if (error instanceof SyntaxError) return Response.json({ error: "invalid_payload" }, { status: 400 });
    throw error;
  }
}
