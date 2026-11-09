import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { data } from "react-router";
import type { Db } from "~/lib/db/client.server";
import { oauthClient } from "~/lib/db/schema";
import { MCP_SCOPES } from "~/lib/connect-paths";
import type { McpAuth } from "./auth.server";

// Whether a signed authorization request (the query carried by /mcp/login and /mcp/consent) is intact and still within its signature's lifetime.
// A request that is not is the usual outcome of a person taking longer than the signature allows, so the screens show it as expired (see AuthorizationExpired) rather than as a bad request.
export async function consentRequestValid(auth: McpAuth, query: string): Promise<boolean> {
  return query.length <= 16_384 && await verifyOAuthQueryParams(query, (await auth.$context).secret);
}

export async function loadConsentRequest(db: Db, auth: McpAuth, query: string) {
  if (!(await consentRequestValid(auth, query))) throw data("Invalid authorization request", { status: 400 });
  const params = new URLSearchParams(query);
  const clientId = params.get("client_id");
  if (!clientId) throw data("Missing client", { status: 400 });
  const [client] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
  if (!client || client.disabled) throw data("Invalid client", { status: 400 });
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  if (scopes.some((scope) => !(MCP_SCOPES as readonly string[]).includes(scope))) throw data("Invalid scope", { status: 400 });
  const uri = params.get("redirect_uri") ?? client.redirectUris[0];
  let redirect: URL;
  try {
    if (!uri) throw new Error("Missing redirect");
    redirect = new URL(uri);
  } catch { throw data("Invalid redirect URI", { status: 400 }); }
  const redirectOrigin = redirect.origin === "null" ? `${redirect.protocol}${redirect.host ? `//${redirect.host}` : ""}` : redirect.origin;
  return { query, clientId, name: client.name ?? clientId, uri: client.uri, scopes, redirectOrigin, registration: client.clientDiscoveryId ? "cimd" as const : "dcr" as const };
}

// Only the provider's validated redirect is used after consent, never a form-supplied redirect URI.
export async function authorizationRedirect(result: unknown): Promise<string | undefined> {
  // Nested provider dispatch may return a Response even for a typed server API call.
  if (result instanceof Response) {
    const location = result.headers.get("location");
    if (location) return location;
    result = await result.json().catch(() => null);
  }
  if (typeof result !== "object" || result === null) return undefined;
  const value = result as { redirect_uri?: unknown; url?: unknown };
  return typeof value.redirect_uri === "string" ? value.redirect_uri : typeof value.url === "string" ? value.url : undefined;
}
