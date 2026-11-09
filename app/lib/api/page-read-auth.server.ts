import { authenticateRead, type ReadAuthResult } from "~/lib/api/read-auth.server";
import { parseCookies } from "better-auth/cookies";
import { errorResponse } from "~/lib/api/http.server";
import { getDb, type Db } from "~/lib/db/client.server";
import { publicReading } from "~/lib/public-reading.server";
import { hitPublicReadLimit, rateLimitHeaders, type RateLimitResult } from "~/lib/rate-limit.server";
import { rememberAiOpenRead, verifyAiOpenMarker } from "~/lib/ai-open-return.server";

type PublicReadAuth = { db: Db; profile: null; carryK: null; rate: RateLimitResult | null };

// Opt-in only for the thread and selected list twins. API/MCP authentication stays unchanged.
export async function authenticatePageRead(request: Request, allowPublic = true): Promise<ReadAuthResult | { ok: true; auth: PublicReadAuth }> {
  const authorization = request.headers.get("authorization");
  const hasBearer = authorization !== null && /^Bearer(?:[ \t]|$)/i.test(authorization);
  const hasKey = new URL(request.url).searchParams.has("k");
  // Even an empty or invalid session cookie is a credential attempt, not anonymous access.
  const hasSession = [...parseCookies(request.headers.get("cookie") ?? "").keys()].some(name => /^(?:__Secure-)?better-auth[.-]session_token$/.test(name));
  if (!allowPublic || !publicReading() || hasBearer || hasKey || hasSession) return authenticateRead(request, "text");
  const db = await getDb();
  const rate = await hitPublicReadLimit(db, request);
  if (rate && !rate.allowed) return { ok: false, response: errorResponse(request, "text", 429, "rate_limited", "Too many reads. Try again later.", rateLimitHeaders(rate)) };
  const markers = new URL(request.url).searchParams.getAll("o");
  if (markers.length === 1) {
    const expiresAt = verifyAiOpenMarker(markers[0], request.url);
    if (expiresAt) await rememberAiOpenRead(db, markers[0], expiresAt);
  }
  return { ok: true, auth: { db, profile: null, carryK: null, rate } };
}
