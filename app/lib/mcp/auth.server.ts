import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { createAuth } from "~/lib/auth/auth.server";
import type { Db } from "~/lib/db/client.server";
import { apiTokens, oauthClient, oauthConsent, mcpRevokedToken } from "~/lib/db/schema";
import { getActiveMember } from "~/lib/members.server";
import type { Profile } from "~/lib/profiles.server";
import { authenticateToken } from "~/lib/tokens.server";
import type { McpClientIdentity } from "./drafts.server";
import { verifyLocalMcpJwt } from "./jwt.server";
import { revokedLineId } from "./line.server";
import { MCP_RESOURCE_SCOPES } from "~/lib/connect-paths";

export type McpPrincipal = { userId: string; profile: Profile; scopes: ReadonlySet<string>; client: McpClientIdentity };
export type McpAuth = ReturnType<typeof createAuth>;
export const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

export function mcpUnauthorized(baseURL: string, status = 401, scope?: string) {
  const metadata = new URL("/.well-known/oauth-protected-resource/mcp", baseURL).href;
  return Response.json({ error: status === 403 ? "insufficient_scope" : "invalid_token" }, { status, headers: {
    "WWW-Authenticate": `Bearer resource_metadata="${metadata}"${scope ? `, scope="${scope}"` : ""}`,
    "Cache-Control": "private, no-store",
  } });
}

export async function withMcpAuth(request: Request, deps: { db: Db; auth: McpAuth; baseURL: string }, next: (principal: McpPrincipal) => Promise<Response>) {
  const raw = /^Bearer[ \t]+([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!raw) return mcpUnauthorized(deps.baseURL);
  if (raw.startsWith("tml_")) {
    const result = await authenticateToken(deps.db, raw);
    if (!result.ok) return mcpUnauthorized(deps.baseURL);
    const profile = await getActiveMember(deps.db, result.token.userId);
    if (!profile) return mcpUnauthorized(deps.baseURL);
    const [token] = await deps.db.select({ name: apiTokens.name }).from(apiTokens).where(eq(apiTokens.id, result.token.id));
    return next({ userId: result.token.userId, profile, scopes: new Set([result.token.kind]), client: {
      key: `token:${result.token.id}`, id: `token:${result.token.id}`, name: token?.name ?? "Personal access token", uri: null, tokenId: result.token.id,
    } });
  }
  const origin = new URL(deps.baseURL).origin;
  const claims = await verifyLocalMcpJwt(request, deps.auth, origin);
  if (!claims) return mcpUnauthorized(origin, 401, MCP_RESOURCE_SCOPES.join(" "));
  // JWT verification alone cannot implement revocation or the creation-client boundary.
  if (typeof claims.sub !== "string" || typeof claims.client_id !== "string" || typeof claims.tomola_consent !== "string" || typeof claims.scope !== "string") return mcpUnauthorized(origin);
  const [grant] = await deps.db.select({ consent: oauthConsent, client: oauthClient }).from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId))
    .where(and(eq(oauthConsent.id, claims.tomola_consent), eq(oauthConsent.userId, claims.sub), eq(oauthConsent.clientId, claims.client_id)));
  // A token carries the mark of its line (tokens issued before the mark existed have none and are judged by the consent alone).
  const ids = [tokenDigest(raw), ...(typeof claims.tomola_line === "string" ? [revokedLineId(claims.tomola_line)] : [])];
  const [revoked] = await deps.db.select({ id: mcpRevokedToken.id }).from(mcpRevokedToken).where(inArray(mcpRevokedToken.id, ids));
  if (!grant || grant.client.disabled || revoked) return mcpUnauthorized(origin);
  const scopes = new Set(claims.scope.split(" ").filter((s) => grant.consent.scopes.includes(s)));
  const profile = await getActiveMember(deps.db, claims.sub);
  if (!profile) return mcpUnauthorized(origin);
  await deps.db.update(oauthConsent).set({ lastUsedAt: new Date() }).where(eq(oauthConsent.id, grant.consent.id));
  return next({ userId: claims.sub, profile, scopes, client: {
    key: `oauth:${claims.client_id}`, id: claims.client_id, name: grant.client.name ?? claims.client_id, uri: grant.client.uri ?? null, tokenId: null,
  } });
}
