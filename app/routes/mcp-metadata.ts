import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { authBaseURL, getAuth } from "~/lib/auth/auth.server";
import { MCP_RESOURCE_SCOPES } from "~/lib/connect-paths";
import type { Route } from "./+types/mcp-metadata";

export async function loader({ request }: Route.LoaderArgs) {
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const origin = new URL(authBaseURL()).origin;
  if (new URL(request.url).pathname.includes("oauth-protected-resource")) return Response.json({
    resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`], scopes_supported: [...MCP_RESOURCE_SCOPES], bearer_methods_supported: ["header"], resource_name: "tomola",
  });
  return oauthProviderAuthServerMetadata(await getAuth())(request);
}
