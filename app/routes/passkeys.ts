import type { Route } from "./+types/passkeys";
import { getAuth } from "~/lib/auth/auth.server";
import { isCredentialSessionFresh } from "~/lib/auth/credential-session.server";
import { requireWriter } from "~/lib/auth/session.server";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "~/lib/auth/passkeys.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { SigningError, signingErrorResponse } from "~/lib/signing.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";

export function loader() { return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const rate = await hitMemberLimit(db, "passkey-enroll", user.id);
  if (!rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "private, no-store" } });
  const current = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!current || !isCredentialSessionFresh(current.session.createdAt)) return Response.json({ error: "SESSION_NOT_FRESH" }, { status: 403 });
  try {
    const body = await request.json();
    const result = body?.intent === "options" ? await passkeyRegistrationOptions(db, user.id, body.name ?? "", body.proof)
      : body?.intent === "verify" && typeof body.challenge === "string" ? await verifyPasskeyRegistration(db, user.id, body.challenge, body.response)
      : (() => { throw new SigningError("invalid_payload", 400); })();
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SigningError) return signingErrorResponse(error);
    if (error instanceof SyntaxError) return Response.json({ error: "invalid_payload" }, { status: 400 });
    throw error;
  }
}
