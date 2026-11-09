import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { mcpRevokedToken, oauthAccessToken, oauthRefreshToken, oauthClient } from "~/lib/db/schema";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { bindAuthToDatabase } from "~/lib/auth/auth.server";
import { mcpUnauthorized, tokenDigest, type McpAuth } from "./auth.server";
import { verifyLocalMcpJwt } from "./jwt.server";
import { MCP_ACCESS_TOKEN_SECONDS, lineMark, revokedLineId } from "./line.server";
import { isCredentialSessionFresh } from "~/lib/auth/credential-session.server";
import { stripAccessTokenAuthorizationScheme } from "better-auth/oauth2";

// Consume bounded machine bodies once. Reconstruct the request so provider parsing has no unchecked stream.
export async function boundedOAuthRequest(request: Request): Promise<Request | null> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 64 * 1024) { void reader.cancel(); return null; }
    chunks.push(part.value);
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: Buffer.concat(chunks), redirect: request.redirect });
}

// Unverified values select a stable client mutex only. The OAuth provider verifies every credential afterwards.
export function oauthCandidateClientId(request: Request, form: FormData): string {
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (basic) {
    try { return decodeURIComponent(Buffer.from(basic[1], "base64").toString("utf8").split(":", 1)[0]); }
    catch { return ""; }
  }
  const explicit = form.get("client_id");
  if (typeof explicit === "string" && explicit) return explicit;
  const assertion = form.get("client_assertion");
  // The complete HTTP body has already passed the 64 KiB cap; do not skip a provider-accepted large assertion.
  if (typeof assertion === "string") {
    try {
      const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
      const candidate = payload.sub ?? payload.iss;
      if (typeof candidate === "string") return candidate;
    } catch { /* Invalid assertions remain the provider's responsibility. */ }
  }
  return "";
}

export async function handleOAuthHttp(request: Request, db: Db, auth: McpAuth, baseURL: string) {
  const bounded = await boundedOAuthRequest(request);
  if (!bounded) return Response.json({ error: "request_too_large" }, { status: 413 });
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/oauth2/token" || path === "/api/auth/oauth2/revoke") {
    let form: FormData;
    try { form = await bounded.clone().formData(); }
    catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    // OAuth parameters may not repeat. Better Call otherwise keeps the last value while FormData.get keeps the first.
    const names = new Set<string>();
    for (const [name, value] of form) {
      if (names.has(name) || typeof value !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
      names.add(name);
    }
    const basic = /^Basic\s+/i.test(bounded.headers.get("authorization") ?? "");
    if ((basic && (form.has("client_assertion") || form.has("client_secret"))) || (form.has("client_assertion") && form.has("client_secret"))) return Response.json({ error: "invalid_request" }, { status: 400 });
    const clientId = oauthCandidateClientId(bounded, form);
    const explicit = form.get("client_id");
    if (basic && typeof explicit === "string" && explicit && explicit !== clientId) return Response.json({ error: "invalid_client" }, { status: 400 });
    return db.transaction(async (tx) => {
      // The candidate id selects a mutex, never an authenticated identity. The provider still validates it.
      await tx.select({ id: oauthClient.id }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).for("no key update");
      // Keep the installed plugins/configuration, but bind all provider grant and token writes to this transaction.
      const transactional = bindAuthToDatabase(auth, tx);
      return processOAuthHttp(bounded, tx, auth, baseURL, transactional.handler);
    });
  }
  return processOAuthHttp(bounded, db, auth, baseURL, auth.handler);
}

const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
const noStore = { "Cache-Control": "no-store" };
const wantsHtml = (request: Request) => (request.headers.get("accept") ?? "").includes("text/html");

// A browser that arrives with an authorization request the server refuses is shown a page for people (/mcp/error), with only the error code carried (a short token, never text from the
// request). Anything else, such as an HTTP client, still gets the JSON answer. The refusal stays local either way: nothing is sent to the client's redirect URI.
function humanError(request: Request, error: string): Response | null {
  if (!wantsHtml(request)) return null;
  const code = /^[a-z_]{1,64}$/.test(error) ? error : "other";
  return new Response(null, { status: 303, headers: { Location: `/mcp/error?${new URLSearchParams({ error: code })}`, ...noStore } });
}

// An authorization request from a browser whose login is older than 24 hours (a login must be recent even when a consent already exists) never lets the provider issue a code:
// the member is sent through the consent screen, which asks for the address check first. A client that asked for prompt=none gets the standard error instead.
// The check fails closed: when the session cannot be read, no request goes on to the provider.
async function freshAuthorization(request: Request, auth: McpAuth): Promise<Request | { error: string; response: Response }> {
  let current: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    current = await auth.api.getSession({ headers: request.headers });
  } catch {
    return { error: "server_error", response: Response.json({ error: "server_error" }, { status: 500, headers: noStore }) };
  }
  if (!current || isCredentialSessionFresh(current.session.createdAt)) return request;
  const url = new URL(request.url);
  const prompts = (url.searchParams.get("prompt") ?? "").split(" ").filter(Boolean);
  if (prompts.includes("none")) return { error: "login_required", response: Response.json({ error: "login_required" }, { status: 400, headers: noStore }) };
  if (prompts.some(prompt => prompt === "consent" || prompt === "login" || prompt === "create")) return request;
  url.searchParams.set("prompt", [...prompts, "consent"].join(" "));
  return new Request(url, { method: request.method, headers: request.headers, redirect: request.redirect });
}

async function processOAuthHttp(bounded: Request, db: Db, auth: McpAuth, baseURL: string, handler: McpAuth["handler"]) {
  let request = bounded;
  if (new URL(request.url).pathname === AUTHORIZE_PATH && request.method === "GET") {
    const checked = await freshAuthorization(request, auth);
    if (!(checked instanceof Request)) return humanError(request, checked.error) ?? checked.response;
    request = checked;
  }
  const revocation = new URL(request.url).pathname === "/api/auth/oauth2/revoke";
  const form = revocation ? await bounded.clone().formData() : null;
  // Use the same optional authorization scheme normalization as the provider.
  const token = stripAccessTokenAuthorizationScheme(String(form?.get("token") ?? ""));
  // The provider reads a refresh token that was already rotated as a replay and ends every refresh token of the member and client. A revocation
  // sent by the client must end only the token's own line, so a rotated token is handed to the provider as if it were live and put back afterwards.
  const sent = revocation && token ? (await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.token, hashMagicLinkToken(token))))[0] : undefined;
  if (sent?.revoked) await db.update(oauthRefreshToken).set({ revoked: null }).where(eq(oauthRefreshToken.id, sent.id));
  const response = await handler(request.clone());
  if (sent) await settleRefreshRevocation(db, sent);
  if (new URL(request.url).pathname === AUTHORIZE_PATH) {
    if (response.status >= 400 && response.status < 500 && wantsHtml(request)) {
      const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
      const refused = humanError(request, typeof body?.error === "string" ? body.error : "other");
      if (refused) return refused;
    }
    // Better Auth's API result is a JSON redirect instruction, not a browser redirect.
    const result = response.ok ? await response.clone().json().catch(() => null) as { redirect?: boolean; url?: string } | null : null;
    const target = response.headers.get("location") ?? (result?.redirect ? result.url : null);
    if (target) {
      const error = new URL(target, baseURL).searchParams.get("error");
      // DCR/CIMD clients are untrusted. Authorize failures must stay local even
      // when the client registered an exact redirect URI. Explicit consent
      // denial is handled separately after the member's decision.
      if (error !== null) return humanError(request, error) ?? Response.json({ error }, { status: 400, headers: noStore });
    }
    if (result?.redirect && typeof result.url === "string") {
      const headers = new Headers(response.headers);
      headers.delete("content-type"); headers.delete("content-length");
      headers.set("Location", result.url);
      return new Response(null, { status: 302, headers });
    }
  }
  if (!revocation) return response;
  // A revoked refresh token ends that token's line only. The member's consent, and every other line of the same client (another machine, another settings
  // directory of the same tool), stay. Cancelling the whole connection is the settings screen's job (revokeConnection).
  if (response.ok) return response;
  if (response.status !== 400) return response;
  const error = await response.clone().json().catch(() => null) as { error?: string } | null;
  if (error?.error !== "unsupported_token_type") return response;
  // The provider has already authenticated the revoking client. Add JWT revocation after its RFC 7009 validation.
  const clientId = oauthCandidateClientId(request, form!);
  const origin = new URL(baseURL).origin;
  const verify = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${token}` } });
  const claims = await verifyLocalMcpJwt(verify, auth, origin);
  if (!claims) return mcpUnauthorized(origin);
  // Revocation of a token from another client succeeds without altering that token (RFC 7009).
  if (claims.client_id !== clientId) return new Response(null, { status: 200 });
  if (typeof claims.exp !== "number") return response;
  await db.delete(mcpRevokedToken).where(lte(mcpRevokedToken.expiresAt, new Date()));
  await db.insert(mcpRevokedToken).values({ id: tokenDigest(token), expiresAt: new Date(claims.exp * 1000) }).onConflictDoNothing();
  return new Response(null, { status: 200 });
}

// Runs after the provider has handled a revocation of a refresh token that exists. The provider revokes the row only when the authenticated client owns it, so a row
// that is revoked now belongs to the caller: end its whole line (rotations share one authorization code), drop the stored replay answers that hold live tokens,
// remove opaque access tokens of the line, and put the line on the revocation list so its access tokens (JWT) stop too. A row that was revoked before is put back as it was.
async function settleRefreshRevocation(db: Db, sent: typeof oauthRefreshToken.$inferSelect) {
  const [after] = await db.select({ revoked: oauthRefreshToken.revoked }).from(oauthRefreshToken).where(eq(oauthRefreshToken.id, sent.id));
  if (after?.revoked && sent.authorizationCodeId) {
    const line = and(eq(oauthRefreshToken.userId, sent.userId), eq(oauthRefreshToken.clientId, sent.clientId), eq(oauthRefreshToken.authorizationCodeId, sent.authorizationCodeId))!;
    await db.update(oauthRefreshToken).set({ revoked: after.revoked }).where(and(line, isNull(oauthRefreshToken.revoked)));
    await db.update(oauthRefreshToken).set({ rotationReplayResponse: null }).where(line);
    // Access tokens are self-contained; put the line on the revocation list for as long as any of its tokens can live.
    const expiresAt = new Date(Date.now() + MCP_ACCESS_TOKEN_SECONDS * 1000);
    await db.delete(mcpRevokedToken).where(lte(mcpRevokedToken.expiresAt, new Date()));
    await db.insert(mcpRevokedToken).values({ id: revokedLineId(lineMark(sent.authorizationCodeId)), expiresAt }).onConflictDoUpdate({ target: mcpRevokedToken.id, set: { expiresAt } });
    await db.delete(oauthAccessToken).where(and(eq(oauthAccessToken.userId, sent.userId), eq(oauthAccessToken.clientId, sent.clientId), eq(oauthAccessToken.authorizationCodeId, sent.authorizationCodeId)));
  }
  if (sent.revoked) await db.update(oauthRefreshToken).set({ revoked: sent.revoked }).where(eq(oauthRefreshToken.id, sent.id));
}
