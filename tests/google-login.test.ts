import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { googleLoginConfig } from "~/lib/auth/google-config.server";
import { invitationCookie, readInvitationCookie } from "~/lib/auth/invitation-cookie.server";
import { createInvitation } from "~/lib/invitations.server";
import { isGoogleAuthEndpoint } from "~/lib/auth/endpoints.server";
import { account, invitations, session, user, verification } from "~/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { createProfile } from "~/lib/profiles.server";
import { action as settingsAction } from "~/routes/settings";
import { action as authAction, loader as authLoader } from "~/routes/api.auth";
import { noticeSources } from "~/lib/notice-sources.server";
import { inviteUrl } from "~/lib/site-url";
import { findValidInvitationByToken } from "~/lib/invitations.server";
import { googleInvitationContext } from "~/lib/auth/google-policy.server";
import { googleBrowserBlocked } from "~/components/google-login";
import { action as inviteAction, loader as inviteLoader } from "~/routes/invite";

vi.hoisted(() => vi.resetModules());
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const BASE = "https://localhost:5581";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" };
function token(claims: Record<string, unknown>) {
  const encoded = [ { alg: "RS256", kid: "fixture-key" }, { iss: "https://accounts.google.com", aud: "fixture-client", sub: "google-subject", email: "alice@gmail.com", email_verified: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...claims } ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
}
function cookies(response: Response, previous = "") {
  const jar = new Map(previous.split("; ").filter(Boolean).map(value => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)]));
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]; const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(claims: Record<string, unknown> = {}) {
  vi.stubEnv("GOOGLE_LOGIN", "1"); vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("BETTER_AUTH_URL", BASE);
  const db = await createTestDb();
  const sent: string[] = [];
  const auth = createAuth(db, { baseURL: BASE, secret: SECRET, sendMagicLink: async ({ url }) => { sent.push(url); } });
  const requests: { url: string; body: URLSearchParams }[] = [];
  let currentClaims = claims;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: token(currentClaims), expires_in: 3600, token_type: "Bearer", scope: "openid email" });
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    throw new Error("Unexpected network request in Google fixture");
  }));
  const request = (path: string, cookie = "", body?: unknown) => new Request(`${BASE}${path}`, { method: body ? "POST" : "GET", headers: { origin: BASE, cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const start = async (cookie = "", body: Record<string, unknown> = {}, link = false) => {
    const response = await googleInvitationContext.run(readInvitationCookie(new Request(BASE, { headers: { cookie } }), SECRET), () => auth.handler(request(`/api/auth/${link ? "link-social" : "sign-in/social"}`, cookie, { provider: "google", callbackURL: link ? "/settings#settings-google" : "/", ...body })));
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(200);
    return { url: new URL(data.url), cookie: cookies(response, cookie) };
  };
  const callback = (flow: { url: URL; cookie: string }, cookie = flow.cookie, extra = "") => auth.handler(request(`/api/auth/callback/google?code=fixture-code&state=${flow.url.searchParams.get("state")}${extra}`, cookie));
  const invite = async (email = "alice@gmail.com") => {
    const value = await createInvitation(db, { email });
    return { ...value, cookie: invitationCookie(new Request(BASE), value.id, SECRET).split(";")[0] };
  };
  const emailLogin = async (email = "alice@gmail.com") => {
    await auth.api.signInMagicLink({ headers: new Headers(), body: { email } });
    return auth.api.magicLinkVerify({ headers: new Headers(), query: { token: new URL(sent.at(-1)!).searchParams.get("token")!, callbackURL: "/" }, asResponse: true });
  };
  return { db, auth, requests, request, start, callback, invite, emailLogin, claims: (value: Record<string, unknown>) => { currentClaims = value; } };
}

describe("Google authorization-code registration", () => {
  it.each([
    ["alice@gmail.com", { email: "Alice@Gmail.com" }],
    ["alice@googlemail.com", { email: "alice@googlemail.com" }],
    ["alice@example.org", { email: "alice@example.org", hd: "example.org" }],
  ])("admits the invited authoritative address %s without storing provider tokens or profile", async (email, claims) => {
    const h = await setup({ ...claims, name: "Ignore provider name", picture: "https://example.invalid/photo" });
    const invitation = await h.invite(email);
    const flow = await h.start(invitation.cookie);
    expect(h.requests).toEqual([]);
    expect(flow.url.pathname).toBe("/o/oauth2/v2/auth");
    expect(flow.url.searchParams.get("scope")).toBe("openid email");
    expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.url.searchParams.has("nonce")).toBe(false);
    expect(flow.url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(flow.url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
    const result = await h.callback(flow);
    expect(result.headers.get("location")).toBe("/onboarding");
    const [member] = await h.db.select().from(user);
    expect(member).toMatchObject({ email, name: "", image: null, emailVerified: true });
    const [connection] = await h.db.select().from(account);
    expect(connection).toMatchObject({ accountId: "google-subject", providerId: "google", accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null });
    expect(await h.db.select().from(invitations)).toMatchObject([{ id: invitation.id, usedBy: member.id, usedAt: expect.any(Date) }]);
    expect(await h.db.select().from(session)).toHaveLength(1);
    const exchange = h.requests.find(request => request.url.endsWith("/token"))!;
    expect(createHash("sha256").update(exchange.body.get("code_verifier")!).digest("base64url")).toBe(flow.url.searchParams.get("code_challenge"));
    expect(exchange.body.get("client_secret")).toBe("fixture-secret");
  });

  it.each([
    [{ email_verified: false }, "google_unverified"],
    [{ email_verified: "true" }, "google_unverified"],
    [{ email: "alice@example.org", hd: "wrong.org" }, "google_unmanaged"],
    [{ email: "alice@example.org" }, "google_unmanaged"],
    [{ email: "other@gmail.com" }, "INVITATION_REQUIRED"],
  ])("rejects ineligible claims %j and leaves email registration usable", async (claims, expected) => {
    const h = await setup(claims);
    const invitation = await h.invite();
    const result = await h.callback(await h.start(invitation.cookie, { errorCallbackURL: "/invite/example-fixture" }));
    expect(new URL(result.headers.get("location")!, BASE).searchParams.get("error")).toBe(expected);
    expect(await h.db.select().from(user)).toHaveLength(0);
    expect(await h.db.select().from(account)).toHaveLength(0);
    expect(await h.db.select().from(invitations)).toMatchObject([{ usedAt: null }]);
    expect((await h.emailLogin()).headers.get("location")).toBe(`${BASE}/`);
  });

  it("does not accept requestSignUp or additionalData as invitation proof", async () => {
    const h = await setup();
    const invitation = await h.invite();
    const flow = await h.start("", { requestSignUp: true, additionalData: { serverContext: { invitationId: invitation.id }, invitationId: invitation.id }, scopes: ["profile"], loginHint: "private@example.com", additionalParams: { include_granted_scopes: "true" } });
    expect(flow.url.searchParams.get("scope")).toBe("openid email");
    expect(flow.url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(flow.url.searchParams.has("login_hint")).toBe(false);
    const result = await h.callback(flow);
    expect(result.headers.get("location")).toContain("error=account_not_linked");
    expect(await h.db.select().from(user)).toHaveLength(0);
  });

  it("rejects a cross-site social POST before issuing authorization state", async () => {
    const h = await setup();
    const request = h.request("/api/auth/sign-in/social", "", { provider: "google" });
    request.headers.set("origin", "https://other.example");
    const response = await h.auth.handler(request);
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it.each(["expired", "revoked", "used"])("rechecks an invitation that became %s after starting OAuth", async state => {
    const h = await setup(); const invitation = await h.invite(); const flow = await h.start(invitation.cookie);
    await h.db.update(invitations).set(state === "expired" ? { expiresAt: new Date(Date.now() - 1000) } : state === "revoked" ? { revokedAt: new Date() } : { usedAt: new Date() }).where(eq(invitations.id, invitation.id));
    // Another invitation for the same address must not act as a fallback.
    await h.invite();
    expect((await h.callback(flow)).headers.get("location")).toContain("error=INVITATION_REQUIRED");
    expect(await h.db.select().from(user)).toHaveLength(0);
  });

  it("keeps the server-bound invitation when another tab changes the cookie", async () => {
    const h = await setup(); const first = await h.invite(); const flow = await h.start(first.cookie); const other = await h.invite("other@gmail.com");
    const cookie = flow.cookie.replace(first.cookie, other.cookie);
    expect((await h.callback(flow, cookie)).headers.get("location")).toBe("/onboarding");
    const rows = await h.db.select().from(invitations);
    expect(rows.find(row => row.id === first.id)?.usedAt).not.toBeNull();
    expect(rows.find(row => row.id === other.id)?.usedAt).toBeNull();
  });

  it("consumes an invitation once across two Google tabs", async () => {
    const h = await setup(); const invitation = await h.invite();
    const flows = await Promise.all([h.start(invitation.cookie), h.start(invitation.cookie)]);
    const results = await Promise.all(flows.map(flow => h.callback(flow)));
    expect(results.filter(result => result.headers.get("location") === "/onboarding")).toHaveLength(1);
    expect(await h.db.select().from(user)).toHaveLength(1);
    expect(await h.db.select().from(account)).toHaveLength(1);
    const [invite] = await h.db.select().from(invitations); const [member] = await h.db.select().from(user);
    expect(invite.usedBy).toBe(member.id);
  });

  it("does not create or implicitly link twice when email and Google race in separate tabs", async () => {
    const h = await setup(); const invitation = await h.invite(); const flow = await h.start(invitation.cookie);
    const results = await Promise.allSettled([h.emailLogin(), h.callback(flow)]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    const members = await h.db.select().from(user); const invites = await h.db.select().from(invitations);
    expect(members).toHaveLength(1); expect(invites[0].usedBy).toBe(members[0].id);
    expect((await h.db.select().from(account)).length).toBeLessThanOrEqual(1);
  });

  it("rejects missing, altered and replayed state", async () => {
    const h = await setup(); const invitation = await h.invite(); const flow = await h.start(invitation.cookie);
    expect((await h.auth.handler(h.request("/api/auth/callback/google?code=fixture-code", flow.cookie))).headers.get("location")).toContain("state_not_found");
    expect((await h.callback({ ...flow, url: new URL(flow.url.toString().replace(/state=[^&]+/, "state=altered")) })).headers.get("location")).toContain("error=");
    expect((await h.callback(flow)).headers.get("location")).toBe("/onboarding");
    expect((await h.callback(flow)).headers.get("location")).toContain("error=");
  });
});

describe("explicit Google connections", () => {
  it("omits the member email from persisted link state while retaining session binding", async () => {
    const h = await setup(); const invitation = await h.invite();
    const cookie = cookies(await h.emailLogin());
    const [member] = await h.db.select().from(user);
    const flow = await h.start(cookie, {}, true);
    const rows = await h.db.select().from(verification);
    const states = rows.map(row => JSON.parse(row.value)).filter(value => value.link);
    expect(states).toHaveLength(1);
    expect(states[0].link).toMatchObject({ email: "", userId: member.id, encryptedSessionToken: expect.any(String) });
    for (const secret of [member.email, invitation.token, `${BASE}/invite/`]) expect(JSON.stringify(rows)).not.toContain(secret);
    expect((await h.callback(flow)).headers.get("location")).toBe("/settings#settings-google");
    expect(await h.db.select().from(account)).toMatchObject([{ userId: member.id, providerId: "google" }]);
  });
  it("requires fresh sessions to connect and disconnect, accepts different email, and signs in by subject without profile changes", async () => {
    const h = await setup(); await h.invite();
    const emailResult = await h.emailLogin(); const originalCookie = cookies(emailResult);
    const [member] = await h.db.select().from(user);
    await h.db.update(user).set({ name: "Member chosen name" }).where(eq(user.id, member.id));
    expect((await h.callback(await h.start())).headers.get("location")).toContain("error=account_not_linked");
    expect(await h.db.select().from(account)).toHaveLength(0);
    const old = new Date(Date.now() - 2 * 86400_000);
    await h.db.update(session).set({ createdAt: old });
    const stale = await h.auth.handler(h.request("/api/auth/link-social", originalCookie, { provider: "google", callbackURL: "/settings" }));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });
    const freshCookie = cookies(await h.emailLogin());
    h.claims({ email: "different@example.org", name: "Do not copy", picture: "https://example.invalid/picture" });
    const linked = await h.callback(await h.start(freshCookie, {}, true));
    expect(linked.headers.get("location")).toBe("/settings#settings-google");
    const [connection] = await h.db.select().from(account);
    expect(connection).toMatchObject({ userId: member.id, accountId: "google-subject", accessToken: null, refreshToken: null, idToken: null });
    // Re-linking an existing connection exercises the account update hook too.
    expect((await h.callback(await h.start(freshCookie, {}, true))).headers.get("location")).toBe("/settings#settings-google");
    expect(await h.db.select().from(account)).toMatchObject([{ accessToken: null, refreshToken: null, idToken: null }]);
    h.claims({ email: "changed@another.org", name: "Changed name" });
    const beforeSession = await h.auth.api.getSession({ headers: new Headers({ cookie: freshCookie }) });
    const login = await h.callback(await h.start(freshCookie));
    expect(login.headers.get("location")).toBe("/");
    const afterSession = await h.auth.api.getSession({ headers: new Headers({ cookie: cookies(login) }) });
    expect(afterSession!.session.token).not.toBe(beforeSession!.session.token);
    expect(await h.db.select().from(user)).toMatchObject([{ id: member.id, email: "alice@gmail.com", name: "Member chosen name", image: null }]);
    expect(await h.db.select().from(account)).toMatchObject([{ accessToken: null, refreshToken: null, idToken: null }]);
    await h.db.update(session).set({ createdAt: old });
    const unlink = () => h.auth.handler(h.request("/api/auth/unlink-account", cookies(login), { accountId: connection.id }));
    expect((await unlink()).status).toBe(403);
    const refreshed = cookies(await h.emailLogin());
    expect((await h.auth.handler(h.request("/api/auth/unlink-account", refreshed, { accountId: connection.id }))).status).toBe(200);
    expect(await h.db.select().from(account)).toHaveLength(0);
    expect((await h.emailLogin()).status).toBe(302);
  });

  it("checks freshness again when a connection callback returns", async () => {
    const h = await setup(); await h.invite(); const cookie = cookies(await h.emailLogin());
    const flow = await h.start(cookie, {}, true);
    await h.db.update(session).set({ createdAt: new Date(Date.now() - 2 * 86400_000) });
    expect((await h.callback(flow)).headers.get("location")).toContain("error=google_reauth");
    expect(await h.db.select().from(account)).toHaveLength(0);
  });

  it("blocks ID-token sign-in and linking without any network request", async () => {
    const h = await setup(); await h.invite(); const cookie = cookies(await h.emailLogin());
    for (const path of ["sign-in/social", "link-social"]) {
      const result = await h.auth.handler(h.request(`/api/auth/${path}`, cookie, { provider: "google", idToken: { token: token({}) }, requestSignUp: true }));
      expect(result.status).toBe(404);
    }
    expect(h.auth.options.socialProviders.google).toMatchObject({ disableIdTokenSignIn: true });
    expect(h.requests).toEqual([]);
  });

  it("does not log provider response details, invitation URLs, addresses or tokens", async () => {
    const h = await setup(); const invitation = await h.invite(); const flow = await h.start(invitation.cookie);
    const writes: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...values) => { writes.push(values); });
    vi.spyOn(console, "error").mockImplementation((...values) => { writes.push(values); });
    const privateText = `alice@gmail.com fixture-access fixture-refresh ${BASE}/invite/${invitation.token}`;
    vi.stubGlobal("fetch", async () => Response.json({ error: privateText, error_description: privateText }, { status: 400 }));
    expect((await h.callback(flow)).headers.get("location")).toContain("error=invalid_code");
    const log = JSON.stringify(writes);
    for (const value of ["alice@gmail.com", "fixture-access", "fixture-refresh", invitation.token]) expect(log).not.toContain(value);
  });

  it("preserves other authentication diagnostics while Google is enabled", async () => {
    const h = await setup();
    const writes: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => { writes.push(values); });
    const flow = await h.start();
    await h.auth.handler(h.request(`/api/auth/callback/google?state=${flow.url.searchParams.get("state")}`, flow.cookie));
    const context = await h.auth.$context;
    context.logger.error("Passkey verification failed");
    context.logger.error("MCP client metadata rejected");
    expect(JSON.stringify(writes)).toContain("Passkey verification failed");
    expect(JSON.stringify(writes)).toContain("MCP client metadata rejected");
  });
});

describe("closed Google configuration and invitation cookie", () => {
  it("fails startup for a missing key or invalid flag without exposing key values", () => {
    expect(googleLoginConfig({})).toBeNull();
    expect(() => googleLoginConfig({ GOOGLE_LOGIN: "0" })).toThrow("GOOGLE_LOGIN must be 1 or empty");
    expect(() => googleLoginConfig({ GOOGLE_LOGIN: "1", GOOGLE_CLIENT_ID: "private-value" })).toThrow("GOOGLE_LOGIN requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  });
  it("does not configure or expose social entrypoints when closed", async () => {
    const h = await setup(); vi.stubEnv("GOOGLE_LOGIN", "");
    const auth = createAuth(h.db, { baseURL: BASE, secret: SECRET, sendMagicLink: async () => {} });
    for (const req of [h.request("/api/auth/sign-in/social", "", { provider: "google" }), h.request("/api/auth/callback/google?code=x&state=y")]) {
      expect(isGoogleAuthEndpoint(req)).toBe(false); expect((await auth.handler(req)).status).toBe(404);
    }
  });
  it("uses a bounded secure, HttpOnly, same-site identifier cookie", () => {
    const now = new Date(); const request = new Request(BASE); const id = "12345678-1234-1234-1234-123456789abc";
    const value = invitationCookie(request, id, SECRET, now);
    expect(value).toMatch(/^__Host-tomola.invitation=/); expect(value).toContain("HttpOnly; SameSite=Lax; Max-Age=3600; Secure");
    const read = new Request(BASE, { headers: { cookie: value.split(";")[0] } });
    expect(readInvitationCookie(read, SECRET, now)).toBe(id);
    expect(readInvitationCookie(read, SECRET, new Date(now.getTime() + 3600_000))).toBeNull();
  });
});

describe("Google application routes and notices", () => {
  async function withAuth<T>(h: Awaited<ReturnType<typeof setup>>, run: () => Promise<T>) {
    const g = globalThis as { __tomolaAuth?: Promise<typeof h.auth>; __tomolaDb?: Promise<typeof h.db> };
    const oldAuth = g.__tomolaAuth; const oldDb = g.__tomolaDb;
    g.__tomolaAuth = Promise.resolve(h.auth); g.__tomolaDb = Promise.resolve(h.db);
    try { return await run(); } finally { g.__tomolaAuth = oldAuth; g.__tomolaDb = oldDb; }
  }
  it("binds the submitted invitation rather than another tab's cookie and stores no secret in OAuth state", async () => {
    const h = await setup(); const first = await h.invite(); const other = await h.invite("other@gmail.com");
    await withAuth(h, async () => {
      const request = new Request(`${BASE}/invite/${first.token}?openExternalBrowser=1`, { method: "POST", headers: { origin: BASE, cookie: other.cookie }, body: new URLSearchParams({ intent: "google-login" }) });
      const redirect = await inviteAction({ request, params: { token: first.token } } as never) as Response;
      const rows = await h.db.select().from(verification);
      const states = rows.map(row => JSON.parse(row.value)).filter(value => value.serverContext);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ serverContext: { invitationId: first.id }, errorURL: "/invite?google=1" });
      for (const secret of [first.token, other.token, first.email, other.email, `${BASE}/invite/`]) expect(JSON.stringify(rows)).not.toContain(secret);
      const flow = { url: new URL(redirect.headers.get("location")!), cookie: cookies(redirect, other.cookie) };
      expect((await h.callback(flow)).headers.get("location")).toBe("/onboarding");
      expect(await h.db.select().from(invitations).where(eq(invitations.id, first.id))).toMatchObject([{ usedAt: expect.any(Date) }]);
      expect(await h.db.select().from(invitations).where(eq(invitations.id, other.id))).toMatchObject([{ usedAt: null }]);
    });
  });
  it("keeps client return URLs and additional data out of plaintext state", async () => {
    const h = await setup(); const invite = await h.invite();
    for (const callbackURL of [`/invite/${invite.token}`, `/%69nvite/${invite.token}`, `/login?email=${invite.email}&token=${invite.token}#${invite.token}`]) {
      await h.start(invite.cookie, { callbackURL, errorCallbackURL: `${BASE}/invite/${invite.token}`, newUserCallbackURL: `/invite/${invite.token}`, additionalData: { email: invite.email, token: invite.token } });
    }
    const values = JSON.stringify(await h.db.select().from(verification));
    for (const secret of [invite.token, invite.email, `${BASE}/invite/`]) expect(values).not.toContain(secret);
  });
  it("does not use an invitation cookie as proof at the public social API", async () => {
    const h = await setup(); const invite = await h.invite();
    const response = await h.auth.handler(h.request("/api/auth/sign-in/social", invite.cookie, { provider: "google" }));
    const flow = { url: new URL((await response.json()).url), cookie: cookies(response, invite.cookie) };
    expect((await h.callback(flow)).headers.get("location")).toContain("error=account_not_linked");
    expect(await h.db.select().from(user)).toHaveLength(0);
  });
  it.each([{ email_verified: false }, { email: "alice@example.org" }])("returns the same ordinary login error for existing and absent addresses with %j", async claims => {
    const h = await setup(claims);
    const absent = await h.callback(await h.start());
    await h.invite(typeof claims.email === "string" ? claims.email : "alice@gmail.com");
    await h.emailLogin(typeof claims.email === "string" ? claims.email : "alice@gmail.com");
    const existing = await h.callback(await h.start());
    expect(absent.headers.get("location")).toBe("/login?google=1&error=account_not_linked");
    expect(existing.headers.get("location")).toBe(absent.headers.get("location"));
    expect(await h.db.select().from(account)).toHaveLength(0);
  });
  it("restores only a valid signed invitation and asks for the email link otherwise", async () => {
    const h = await setup(); vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const invite = await h.invite();
    await withAuth(h, async () => {
      const load = (cookie: string, token?: string) => inviteLoader({ request: new Request(`${BASE}/invite?google=1&error=access_denied`, { headers: { cookie } }), params: { token } } as never);
      expect(await load(invite.cookie)).toMatchObject({ email: invite.email, reopenInvitation: false });
      for (const cookie of ["", `${invite.cookie}altered`, invitationCookie(new Request(BASE), invite.id, SECRET, new Date(Date.now() - 3600_000)).split(";")[0]]) {
        expect(await load(cookie)).toMatchObject({ email: null, reopenInvitation: true });
      }
      expect(await load(invite.cookie, "invalid-token")).toMatchObject({ email: null });
      for (const change of [{ expiresAt: new Date(Date.now() - 1) }, { revokedAt: new Date() }, { usedAt: new Date() }]) {
        await h.db.update(invitations).set({ expiresAt: new Date(Date.now() + 86400_000), revokedAt: null, usedAt: null, ...change }).where(eq(invitations.id, invite.id));
        expect(await load(invite.cookie)).toMatchObject({ email: null, reopenInvitation: true });
      }
    });
  });
  it("clears the invitation cookie only on successful callback and closes both HTTP routes when disabled", async () => {
    const h = await setup(); const invite = await h.invite();
    await withAuth(h, async () => {
      const flow = await h.start(invite.cookie);
      const request = h.request(`/api/auth/callback/google?code=fixture-code&state=${flow.url.searchParams.get("state")}`, flow.cookie);
      const result = await authLoader({ request } as never);
      expect(result.headers.getSetCookie()).toContain("__Host-tomola.invitation=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(result.headers.get("cache-control")).toBe("no-store");
      vi.stubEnv("GOOGLE_LOGIN", "");
      expect((await authLoader({ request } as never)).status).toBe(404);
      expect((await authAction({ request: h.request("/api/auth/sign-in/social", "", { provider: "google" }) } as never)).status).toBe(404);
    });
  });
  it("settings require re-verification and never unlink another member's account", async () => {
    const h = await setup(); await h.invite(); const cookie = cookies(await h.emailLogin());
    const [member] = await h.db.select().from(user); await createProfile(h.db, member.id, { handle: "alice", homeArea: "en", readLangs: ["en"] });
    await withAuth(h, async () => {
      await h.db.update(session).set({ createdAt: new Date(Date.now() - 2 * 86400_000) });
      const form = (intent: string, cookie: string, accountId = "missing") => new Request(`${BASE}/settings`, { method: "POST", headers: { origin: BASE, cookie }, body: new URLSearchParams({ intent, accountId }) });
      await expect(settingsAction({ request: form("google-link", cookie) })).rejects.toMatchObject({ status: 302 });
      const fresh = cookies(await h.emailLogin());
      const redirect = await settingsAction({ request: form("google-link", fresh) }) as Response;
      expect(new URL(redirect.headers.get("location")!).hostname).toBe("accounts.google.com");
      expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
      await expect(settingsAction({ request: form("google-unlink", fresh, "someone-elses-account") })).rejects.toMatchObject({ status: 404 });
    });
  });
  it("keeps invitation tokens unchanged in external-browser links and adds privacy text only when enabled", async () => {
    const h = await setup(); const invitation = await h.invite();
    const url = new URL(inviteUrl(invitation.token));
    expect(url.searchParams.get("openExternalBrowser")).toBe("1");
    expect(await findValidInvitationByToken(h.db, url.pathname.split("/").at(-1)!)).toMatchObject({ id: invitation.id });
    expect(noticeSources("privacy").en).toContain("Google learns that you sign in to tomola");
    expect(noticeSources("terms").en).not.toContain("Google sign-in");
    vi.stubEnv("GOOGLE_LOGIN", "");
    expect(noticeSources("privacy").en).not.toContain("Google sign-in");
  });
});

it("recognizes additional embedded browsers while preserving ordinary browsers", () => {
  for (const ua of ["KAKAOTALK 26.1", "NAVER(inapp; search; 2100)", "MicroMessenger/8.0", "Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36"]) expect(googleBrowserBlocked(ua, false), ua).toBe(true);
  for (const ua of ["Mozilla/5.0 Firefox/144.0", "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36", "NAVER Whale/4.0"]) expect(googleBrowserBlocked(ua, false), ua).toBe(false);
});
