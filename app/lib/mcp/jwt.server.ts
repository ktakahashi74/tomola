import { enforceDpopBinding, parseAccessTokenAuthorization, createDpopReplayStore, verifyJwsAccessToken } from "better-auth/oauth2";
import type { Auth } from "~/lib/auth/auth.server";

// Authorization and MCP run in this process. Read its public keys through the
// provider API instead of fetching the public hostname from inside a container.
// Keep the public issuer/audience and the provider's signature and DPoP checks.
export async function verifyLocalMcpJwt(request: Request, auth: Auth, baseURL: string) {
  const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
  if (!authorization?.token || authorization.scheme !== "Bearer") return null;
  // JOSE accepts some base64url aliases of the same signature bytes. Require
  // the provider's canonical spelling so raw-token revocation cannot be bypassed.
  const parts = authorization.token.split(".");
  const signature = parts[2];
  if (parts.length !== 3 || !signature || Buffer.from(signature, "base64url").toString("base64url") !== signature) return null;
  const origin = new URL(baseURL).origin;
  try {
    const context = await auth.$context;
    const payload = await verifyJwsAccessToken(authorization.token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: auth,
      verifyOptions: { issuer: `${origin}/api/auth`, audience: `${origin}/mcp` },
    });
    await enforceDpopBinding({
      payload, authorization, proofJwt: request.headers.get("dpop"),
      method: request.method, url: request.url,
      replayStore: createDpopReplayStore(context.internalAdapter),
    });
    return payload;
  } catch {
    return null;
  }
}
