import { createHash } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { magicLink, jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { fetchMcpClientMetadata } from "~/lib/mcp/cimd.server";
import { browserBindingIdentifier, browserNonceDigest, validBrowserNonce } from "./magic-link-browser.server";
import { magicLinkNextIdentifier, safeMagicLinkNext } from "./magic-link-next.server";
import { APIError } from "better-auth/api";
import { MCP_SCOPES } from "~/lib/connect-paths";
import { MCP_ACCESS_TOKEN_SECONDS, lineMark } from "~/lib/mcp/line.server";

// Magic-link token storage in the DB verification table: SHA-256 encoded as unpadded base64url. This matches Better Auth's default (storeToken: "hashed"),
// but keep the function here so the app can compute it. When refusing delivery for an unknown recipient or rate limit, the app uses it to delete the row Better Auth wrote before sending
// (identifier is magic-link: plus this value in Better Auth 1.7.7; value contains the email address). See app/lib/auth/magic-link.server.ts.
export function hashMagicLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

// metadata is an arbitrary value passed in the signInMagicLink body, such as the email language (app/lib/mail/magic-link.server.ts).
// The second argument is Better Auth's endpoint context (call headers and request), used to obtain the IP address.
export type MagicLinkContext = { headers?: Headers; request?: Request } | undefined;
export type SendMagicLink = (
  args: { email: string; url: string; token: string; metadata?: Record<string, unknown> },
  ctx?: MagicLinkContext,
) => Promise<void>;

// Derive the passkey rpID (hostname) and origin from baseURL (BETTER_AUTH_URL). Passkeys work only on the site where they were registered
// (a different rpID prevents the browser from offering another site's credentials). Compare origin with what the browser sends, without relying on the request's Origin header.
export function authPlugins(sendMagicLink: SendMagicLink, opts: { baseURL: string; metadataFetch?: typeof fetchClientMetadataResource }) {
  const site = new URL(opts.baseURL);
  return [
    magicLink({
      expiresIn: 60 * 15,
      storeToken: { type: "custom-hasher", hash: async (token) => hashMagicLinkToken(token) },
      sendMagicLink: async ({ email, url, token, metadata }, ctx) => {
        if (validBrowserNonce(metadata?.browserNonce)) {
          if (!ctx) throw new Error("Magic-link browser binding requires the provider context");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: browserBindingIdentifier(token),
            value: browserNonceDigest(metadata.browserNonce),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          });
          const next = safeMagicLinkNext(metadata?.next);
          if (next !== "/") {
            const credential = await ctx.context.internalAdapter.findVerificationValue(`magic-link:${hashMagicLinkToken(token)}`);
            if (credential) {
              try {
                await ctx.context.internalAdapter.createVerificationValue({
                  identifier: magicLinkNextIdentifier(token), value: next, expiresAt: credential.expiresAt,
                });
              } catch {
                // SQL errors can contain parameter values. Never propagate the private destination or the original error/cause into logs.
                throw new Error("Could not store magic-link return destination");
              }
            }
          }
        }
        await sendMagicLink({ email, url, token, metadata }, ctx);
      },
    }),
    // Passkeys: registration requires a logged-in member (registration.requireSession defaults to true; from /settings). Login requires
    // a user with an existing registered passkey. Users without passkeys cannot be created this way, so invitation-only access cannot be bypassed.
    passkey({ rpID: site.hostname, rpName: "tomola", origin: site.origin, authentication: { afterVerification: async ({ verification }) => {
      if (!verification.authenticationInfo.userVerified) throw new APIError("UNAUTHORIZED", { code: "USER_VERIFICATION_REQUIRED", message: "User verification required" });
    } } }),
    jwt({ jwt: { issuer: `${site.origin}/api/auth` } }),
    mcp({
      loginPage: "/mcp/login",
      consentPage: "/mcp/consent",
      resource: `${site.origin}/mcp`,
      scopes: [...MCP_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      // A client that registers itself without saying what kind of client it is (Gemini CLI) is told apart by its redirect URI: plain http is accepted only for
      // a loopback address (localhost, 127.0.0.1, [::1]); any other host still needs https.
      clientRegistrationDefaultApplicationType: "infer",
      // Access tokens last 15 minutes. Revoking a connection or suspending a member is checked on every request (withMcpAuth), so a longer token does not delay either.
      // A refresh token used a second time within 30 seconds (two processes sharing one credential, a retry after a lost reply) is tolerated; beyond that the
      // library treats it as theft and ends every connection of that member and client.
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_SECONDS,
      refreshTokenReuseInterval: 30,
      storeTokens: { hash: async (token) => hashMagicLinkToken(token) },
      extensions: [{ claims: { accessToken: async ({ ctx, client, user, grantType }) => {
        if (!user) throw new Error("MCP requires a member authorization grant");
        // A new consent gets a new id. Old JWTs remain rejected after revoke/reconnect, even if still signed and unexpired.
        const consent = await ctx.context.adapter.findOne<{ id: string }>({
          model: "oauthConsent", where: [{ field: "clientId", value: client.clientId }, { field: "userId", value: user.id }],
        });
        if (!consent) throw new Error("MCP requires active consent");
        // The token's line: the code grant names the authorization code, the refresh grant names a refresh token that carries the code id. Without either, no mark is written
        // and the token is judged by its consent alone.
        const body = (ctx as { body?: { code?: unknown; refresh_token?: unknown } }).body;
        let codeId: string | null | undefined;
        if (grantType === "refresh_token" && typeof body?.refresh_token === "string") {
          const row = await ctx.context.adapter.findOne<{ authorizationCodeId?: string | null }>({ model: "oauthRefreshToken", where: [{ field: "token", value: hashMagicLinkToken(body.refresh_token) }] });
          codeId = row?.authorizationCodeId;
        } else if (grantType === "authorization_code" && typeof body?.code === "string") codeId = hashMagicLinkToken(body.code);
        return { tomola_consent: consent.id, ...(codeId ? { tomola_line: lineMark(codeId) } : {}) };
      } } }],
    }),
    cimd({ metadataProfile: "mcp-2026-07-28", fetchClientMetadataResource: opts.metadataFetch ?? fetchMcpClientMetadata }),
  ];
}
