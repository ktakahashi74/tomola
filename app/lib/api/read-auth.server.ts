import { getSessionUser } from "~/lib/auth/session.server";
import { getDb, type Db } from "~/lib/db/client.server";
import { BEARER_PATTERN, bearerChallenge, errorResponse, type Format } from "~/lib/api/http.server";
import { isOpenInAiToken, verifyOpenInAiToken } from "~/lib/open-in-ai.server";
import { getActiveMember } from "~/lib/members.server";
import type { Profile } from "~/lib/profiles.server";
import { hitIpLimit, hitRateLimit, rateLimitHeaders, READ_RATE_LIMIT, type RateLimitResult, type RateLimitRule } from "~/lib/rate-limit.server";
import { authenticateToken } from "~/lib/tokens.server";
import { rememberAiOpenRead, signedAiOpenExpiry } from "~/lib/ai-open-return.server";

// Authentication for Markdown and read-only JSON (/t/:id.md, /latest.md, /home.md, /a/:lang.md, /changes.md, /manifest.json).
// Member-only requests without authentication receive 401 (WWW-Authenticate: Bearer). Accept any of:
//   1. Session cookies (browser actions such as 「Markdownでコピー」).
//   2. Authorization: Bearer tml_read_… (read token).
//   3. ?k=… (a read token itself or a signed 「AIで開く」 token), for fetchers that cannot set headers.
// If supplied credentials (Bearer or k) are invalid, return 401 without falling back to cookies, so the failure remains identifiable.
// Treat Authorization headers using a scheme other than Bearer as absent.
// Read Bearer and ?k= only here (read-only GETs). Neither HTML page routes nor writes read them.
// Draft tokens cannot read (403 wrong_token_kind).
//
// Rate limits: 600 reads/hour per member, shared by browser, API, delegated links and MCP.
// Requests with missing or invalid credentials (invalid tokens or signatures) are limited to 120/hour per IP (429 instead of 401 when exceeded).
// Markdown search (/search.md) additionally applies the search limit of 60/hour per member.

export type ReadAuth = {
  db: Db;
  userId: string;
  profile: Profile;
  via: "session" | "read-token" | "signed-link";
  // Credentials are never copied into response links; retained for the shared URL DTO.
  carryK: string | null;
  rate: RateLimitResult | null;
};

export type ReadAuthResult = { ok: true; auth: ReadAuth } | { ok: false; response: Response };

export async function authenticateRead(
  request: Request,
  format: Format,
  opts: { now?: Date; db?: Db; rule?: RateLimitRule } = {},
): Promise<ReadAuthResult> {
  const db = opts.db ?? (await getDb());
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}): ReadAuthResult => ({
    ok: false,
    response: errorResponse(request, format, status, code, message, headers),
  });
  // Count requests with missing or invalid credentials against the per-IP limit (ANON_IP_LIMIT). Return 429 if exceeded.
  const denied = async (status: number, code: string, message: string, headers: Record<string, string> = {}): Promise<ReadAuthResult> => {
    const rate = await hitIpLimit(db, request, "anon", opts.now);
    if (rate && !rate.allowed) return fail(429, "rate_limited", `Too many requests without valid credentials. Try again in ${rate.retryAfterSeconds} seconds.`, rateLimitHeaders(rate));
    return fail(status, code, message, headers);
  };
  const invalid = (message: string) => denied(401, "invalid_token", message, bearerChallenge("invalid_token"));
  const wrongKind = () => fail(403, "wrong_token_kind", "This is a draft token. Reading needs a read token (tml_read_…).");

  let via: ReadAuth["via"];
  let userId: string;
  let carryK: string | null = null;
  let rateKey: string | null = null;
  let profile: Profile | null = null;

  // Read Authorization as a token only with the Bearer scheme. Ignore other schemes (such as Basic, which a staging proxy may add)
  // and authenticate through ?k= or session cookies instead.
  const authorization = request.headers.get("authorization");
  const bearer = authorization !== null && /^Bearer(?:[ \t]|$)/i.test(authorization) ? authorization : null;
  const k = new URL(request.url).searchParams.get("k");
  if (bearer !== null) {
    const token = BEARER_PATTERN.exec(bearer)?.[1];
    if (!token) return await invalid("The Authorization header must be: Bearer <read token>.");
    const res = await authenticateToken(db, token, { now: opts.now });
    if (!res.ok) return await invalid("The token is not valid, or it was revoked.");
    if (res.token.kind !== "read") return wrongKind();
    via = "read-token";
    userId = res.token.userId;
    rateKey = `read:member:${res.token.userId}`;
  } else if (k !== null) {
    if (isOpenInAiToken(k)) {
      const res = await verifyOpenInAiToken(db, k, { now: opts.now, resource: request.url });
      if (!res.ok) return await invalid(`The link is not valid (${res.error}). Open the page again from the site to get a new one.`);
      via = "signed-link";
      userId = res.userId;
      profile = res.profile;
      rateKey = `read:member:${res.userId}`;
    } else {
      const res = await authenticateToken(db, k, { now: opts.now });
      if (!res.ok) return await invalid("The token is not valid, or it was revoked.");
      if (res.token.kind !== "read") return wrongKind();
      via = "read-token";
      userId = res.token.userId;
      rateKey = `read:member:${res.token.userId}`;
    }
    // Neither personal tokens nor delegated links may leak into returned links.
    carryK = null;
  } else {
    const user = await getSessionUser(request);
    if (!user) return denied(401, "unauthorized", "Members only. Send a read token: Authorization: Bearer tml_read_… (see /help/ai.md).", bearerChallenge());
    via = "session";
    userId = user.id;
    rateKey = `read:member:${user.id}`;
  }

  profile ??= await getActiveMember(db, userId);
  // Tokens belonging to users who are no longer active members cannot be used.
  if (!profile) return fail(403, "not_a_member", "This account has not finished signing up.");

  let rate: RateLimitResult | null = null;
  if (rateKey !== null) {
    rate = await hitRateLimit(db, { key: rateKey, ...(opts.rule ?? READ_RATE_LIMIT), now: opts.now });
    if (!rate.allowed) {
      return fail(429, "rate_limited", `Too many requests. Try again in ${rate.retryAfterSeconds} seconds.`, rateLimitHeaders(rate));
    }
  }
  if (via === "signed-link") await rememberAiOpenRead(db, k!, signedAiOpenExpiry(request.url));
  return { ok: true, auth: { db, userId, profile, via, carryK, rate } };
}
