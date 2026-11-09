import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "~/lib/auth/auth.server";
import { oauthClient, oauthConsent, oauthRefreshToken } from "~/lib/db/schema";
import { withMcpAuth } from "~/lib/mcp/auth.server";
import { authorizationRedirect } from "~/lib/mcp/consent.server";
import { pruneRotationReplays, revokeConnection } from "~/lib/mcp/connections.server";
import { handleOAuthHttp } from "~/lib/mcp/oauth-http.server";
import { addMember } from "./helpers/db";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

// Real provider writes, independent DB connections, deterministic lock arrival order. No external HTTP or model calls.
describe.skipIf(!REAL_PG_URL)("OAuth issuance and connection cancellation on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  let admin: pg.Client;
  let sequence = 0;
  const baseURL = "http://127.0.0.1:5173";
  const secret = "oauth-race-fixture-0123456789abcdef0123456789";
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 120_000);
  afterEach(async () => { await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); }, 60_000);

  it("prunes expired replays in bounded batches without waiting for a locked token", async () => {
    const [block, cleanup] = await Promise.all([scratch.open("replay-block"), scratch.open("replay-cleanup")]);
    const owner = "replay-cleanup-member";
    await addMember(block, owner, "replay_cleanup_member");
    const clientId = "replay-cleanup-client";
    await block.insert(oauthClient).values({ id: clientId, clientId, redirectUris: [`${baseURL}/callback`] });
    const now = new Date();
    const values = Array.from({ length: 105 }, (_, index) => ({ id: `replay-${String(index).padStart(3, "0")}`, token: `replay-token-${index}`,
      clientId, userId: owner, createdAt: now, expiresAt: new Date(now.getTime() + 86400_000), scopes: ["read"],
      rotationReplayExpiresAt: new Date(now.getTime() - 1000), rotationReplayResponse: "encrypted-test-answer" }));
    await block.insert(oauthRefreshToken).values(values);
    const held = holdTx(block, tx => tx.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.id, values[0].id)).for("update"));
    await held.ready;
    try {
      expect(await expectSettlesWithin(pruneRotationReplays(cleanup, now), 10_000, "cleanup skips a locked replay")).toBe(104);
      expect((await cleanup.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.id, values[0].id)))[0].rotationReplayResponse).toBe("encrypted-test-answer");
    } finally { await held.rollback(); }
    expect(await pruneRotationReplays(cleanup, now)).toBe(1);
  });

  it.each([ ["public", "issue"], ["public", "cancel"], ["private_key_jwt", "issue"], ["private_key_jwt", "cancel"], ["public", "revoke"] ] as const)(
    "%s client, %s arrives first: no refresh or JWT survives cancellation", async (method, first) => {
      const [block, issue, cancel] = await Promise.all([scratch.open("oauth-block"), scratch.open("oauth-issue"), scratch.open("oauth-cancel")]);
      const userId = `oauth-member-${++sequence}`;
      await addMember(block, userId, `oauth_${sequence}`);
      let magicToken = "";
      const options = { baseURL, secret, sendMagicLink: async ({ token }: { token: string }) => { magicToken = token; } };
      const auth = createAuth(block, options);
      await auth.api.signInMagicLink({ body: { email: `${userId}@example.com` }, headers: new Headers() });
      const verified = await auth.api.magicLinkVerify({ query: { token: magicToken }, headers: new Headers(), asResponse: true });
      const cookie = verified.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "race-key", alg: "ES256", use: "sig" };
      const registration = await handleOAuthHttp(new Request(`${baseURL}/api/auth/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Fictional race client", application_type: "native", redirect_uris: [`${baseURL}/callback`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "read offline_access", token_endpoint_auth_method: method === "public" ? "none" : method, ...(method === "private_key_jwt" ? { jwks: { keys: [jwk] } } : {}) }) }), block, auth, baseURL);
      expect(registration.status, await registration.clone().text()).toBe(201);
      const clientId = (await registration.json()).client_id as string;
      const credentials = (): Record<string, string> => {
        if (method === "public") return { client_id: clientId };
        const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: jwk.kid })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ iss: clientId, sub: clientId, aud: `${baseURL}/api/auth/oauth2/token`, exp: Math.floor(Date.now() / 1000) + 120, jti: randomUUID(), padding: "p".repeat(17 * 1024) })).toString("base64url");
        const unsigned = `${header}.${payload}`;
        return { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}` };
      };
      const verifier = "v".repeat(64);
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: `${baseURL}/callback`, response_type: "code", scope: "read offline_access", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: `${baseURL}/mcp` });
      const authorized = await handleOAuthHttp(new Request(`${baseURL}/api/auth/oauth2/authorize?${query}`, { headers: { cookie } }), block, auth, baseURL);
      expect(authorized.status).toBe(302);
      const consent = new URL(authorized.headers.get("location")!, baseURL);
      const headers = new Headers({ cookie, origin: baseURL });
      const approved = await auth.api.oauth2Consent({ request: new Request(`${baseURL}/mcp/consent`, { method: "POST", headers }), headers, body: { accept: true, scope: "read offline_access", oauth_query: consent.searchParams.toString() } });
      const callback = new URL((await authorizationRedirect(approved))!);
      const post = (parameters: Record<string, string>) => new Request(`${baseURL}/api/auth/oauth2/token`, { method: "POST", body: new URLSearchParams(parameters) });
      const initial = await handleOAuthHttp(post({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: `${baseURL}/callback`, code_verifier: verifier, resource: `${baseURL}/mcp`, ...credentials() }), block, auth, baseURL);
      expect(initial.status, await initial.clone().text()).toBe(200);
      const token = await initial.json();
      const accessTokens = [token.access_token];
      if (first === "revoke") {
        const rotated = await handleOAuthHttp(post({ grant_type: "refresh_token", refresh_token: token.refresh_token, ...credentials() }), block, auth, baseURL);
        expect(rotated.status).toBe(200);
        accessTokens.push((await rotated.json()).access_token);
      }
      const [grant] = await block.select().from(oauthConsent).where(eq(oauthConsent.clientId, clientId));
      const held = holdTx(block, tx => tx.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).for("no key update"));
      await held.ready;
      let issuing!: Promise<Response>;
      let cancelling!: Promise<boolean>;
      try {
        const startIssue = () => handleOAuthHttp(post({ grant_type: "refresh_token", refresh_token: token.refresh_token, ...credentials() }), issue, createAuth(issue, options), baseURL);
        if (first === "issue") {
          issuing = startIssue(); await waitForLockWait(admin, "oauth-issue");
          cancelling = revokeConnection(cancel, userId, grant.id); await waitForLockWait(admin, "oauth-cancel");
        } else {
          cancelling = first === "revoke"
            ? handleOAuthHttp(new Request(`${baseURL}/api/auth/oauth2/revoke`, { method: "POST", body: new URLSearchParams({ token: token.refresh_token, ...credentials() }) }), cancel, createAuth(cancel, options), baseURL).then(response => response.ok)
            : revokeConnection(cancel, userId, grant.id);
          await waitForLockWait(admin, "oauth-cancel");
          issuing = startIssue(); await waitForLockWait(admin, "oauth-issue");
        }
      } finally { await held.commit(); }
      const [response, revoked] = await expectSettlesWithin(Promise.all([issuing, cancelling]), 15_000, "OAuth refresh and cancellation");
      expect(revoked).toBe(true);
      expect(response.status).toBe(first === "issue" ? 200 : 400);
      expect(await block.select().from(oauthConsent).where(eq(oauthConsent.clientId, clientId))).toHaveLength(first === "revoke" ? 1 : 0);
      const remaining = await block.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, clientId));
      if (first === "revoke") {
        expect(remaining.length).toBeGreaterThan(0);
        expect(remaining.every(row => row.revoked && !row.rotationReplayResponse)).toBe(true);
      } else expect(remaining).toHaveLength(0);
      for (const accessToken of [...accessTokens, ...(response.ok ? [(await response.json()).access_token] : [])]) {
        const request = new Request(`${baseURL}/mcp`, { headers: { authorization: `Bearer ${accessToken}` } });
        expect((await withMcpAuth(request, { db: block, auth, baseURL }, async () => new Response(null, { status: 200 }))).status).toBe(401);
      }
    }, 60_000);
});
