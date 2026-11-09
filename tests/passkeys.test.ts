import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ALLOWED_AUTH_ENDPOINTS } from "~/lib/auth/endpoints.server";
import { passkey, session, user } from "~/lib/db/schema";
import { action as authAction, loader as authLoader } from "~/routes/api.auth";
import { action as enrollAction } from "~/routes/passkeys";
import { action as settingsAction, loader as settingsLoader } from "~/routes/settings";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Passkeys: only the two login endpoints are exposed over HTTP; registration requires a logged-in member and login requires a user with a passkey.
// Registration and login with an actual authenticator, Chromium's virtual authenticator, are covered by e2e/passkey.spec.ts.
const BASE = "http://localhost:5173";
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("kim", { homeArea: "ja" });
});
afterAll(() => h.restore());
afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

const call = async (method: "GET" | "POST", path: string, opts: { as?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { origin: BASE, ...opts.headers };
  if (opts.as) headers.cookie = h.request("/", { as: opts.as }).headers.get("cookie")!;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`${BASE}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  return (method === "GET" ? (await authLoader(h.args(request))) : authAction(h.args(request))) as Promise<Response>;
};

const enroll = (as: string | undefined, body: unknown) => enrollAction(h.args(new Request(`${BASE}/passkeys`, {
  method: "POST", headers: { origin: BASE, "content-type": "application/json", ...(as ? { cookie: h.request("/", { as }).headers.get("cookie")! } : {}) }, body: JSON.stringify(body),
})));

const insertPasskey = (userId: string, id: string, extra: Partial<typeof passkey.$inferInsert> = {}) =>
  h.db.insert(passkey).values({ id, userId, publicKey: "pk", credentialID: `cred-${id}`, counter: 0, deviceType: "multiDevice", backedUp: true, createdAt: new Date("2026-09-30T12:00:00Z"), ...extra });

describe("the open passkey endpoints", () => {
  it("are exactly the two login endpoints the client needs", () => {
    expect(ALLOWED_AUTH_ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      "GET /passkey/generate-authenticate-options",
      "POST /passkey/verify-authentication",
    ]);
  });

  it("issue login options to anyone, for this site only, with a signed challenge cookie", async () => {
    const res = await call("GET", "/api/auth/passkey/generate-authenticate-options");
    expect(res.status).toBe(200);
    const options = (await res.json()) as { challenge: string; rpId: string };
    expect(options.challenge).toMatch(/\S{20,}/);
    // rpID is the hostname of BETTER_AUTH_URL.
    expect(options.rpId).toBe("localhost");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("better-auth.better-auth-passkey="))).toBe(true);
  });

  it("closes plugin registration and requires a session on the dedicated enrollment endpoint", async () => {
    expect((await call("GET", "/api/auth/passkey/generate-register-options")).status).toBe(404);
    expect((await call("POST", "/api/auth/passkey/verify-registration", { body: {} })).status).toBe(404);
    expect(await h.outcome(() => enroll(undefined, { intent: "options", name: "laptop" }))).toMatchObject({ status: 302, location: "/login" });
  });

  it("offers UV-required registration options bound to the signed-in member and this site", async () => {
    const res = await enroll("hana", { intent: "options", name: "laptop" });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.needsProof).toBe(false);
    expect(result.options.rp).toEqual({ id: "localhost", name: "tomola" });
    expect(result.options.user.name).toBe("hana");
    expect(result.options.authenticatorSelection.userVerification).toBe("required");
  });

  it("caps the passkey name before issuing registration options", async () => {
    expect((await enroll("hana", { intent: "options", name: "a".repeat(64) })).status).toBe(200);
    const long = await enroll("hana", { intent: "options", name: "a".repeat(65) });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "name_too_long" });
  });

  it("refuses enrollment with an old session", async () => {
    await h.db.update(session).set({ createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) }).where(eq(session.userId, h.ids.kim));
    const res = await enroll("kim", { intent: "options", name: "laptop" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "SESSION_NOT_FRESH" });
  });

  it("log nobody in with a credential the site does not know, and never create a user", async () => {
    const users = (await h.db.select().from(user)).length;
    const sessions = (await h.db.select().from(session)).length;
    const options = await call("GET", "/api/auth/passkey/generate-authenticate-options");
    const challengeCookie = options.headers.getSetCookie().find((c) => c.startsWith("better-auth.better-auth-passkey="))!.split(";")[0];
    const res = await call("POST", "/api/auth/passkey/verify-authentication", {
      body: { response: { id: "unknown-credential", rawId: "unknown-credential", type: "public-key", response: {} } },
      headers: { cookie: challengeCookie },
    });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
    expect((await h.db.select().from(user)).length).toBe(users);
    expect((await h.db.select().from(session)).length).toBe(sessions);
  });

  it("refuse verification without a challenge cookie", async () => {
    const res = await call("POST", "/api/auth/passkey/verify-authentication", { body: { response: { id: "x", rawId: "x", type: "public-key", response: {} } } });
    expect(res.status).toBe(400);
  });

  it("are limited per IP (60 per 15 minutes), when the address is known", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const get = () => call("GET", "/api/auth/passkey/generate-authenticate-options", { headers: { "x-forwarded-for": "198.51.100.77" } });
    for (let i = 0; i < 60; i++) expect((await get()).status).toBe(200);
    const refused = await get();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different IP passes.
    expect((await call("GET", "/api/auth/passkey/generate-authenticate-options", { headers: { "x-forwarded-for": "198.51.100.78" } })).status).toBe(200);
    // An endpoint outside the allowlist returns 404 without counting.
    expect((await call("GET", "/api/auth/get-session", { headers: { "x-forwarded-for": "198.51.100.77" } })).status).toBe(404);
  });
});

describe("the passkey list in /settings", () => {
  it("lists only the member's own passkeys, without keys or credential ids", async () => {
    await insertPasskey(h.ids.hana, "p-hana-1", { name: "laptop" });
    await insertPasskey(h.ids.hana, "p-hana-2", { name: null, backedUp: false, createdAt: new Date("2026-10-01T09:00:00Z") });
    await insertPasskey(h.ids.kim, "p-kim-1", { name: "kim's" });
    const data = (await settingsLoader(h.args(h.request("/settings", { as: "hana" })))) as unknown as { passkeys: Array<Record<string, unknown>> };
    expect(data.passkeys).toEqual([
      { id: "p-hana-1", name: "laptop", createdAt: "2026-09-30T12:00:00.000Z", backedUp: true },
      { id: "p-hana-2", name: null, createdAt: "2026-10-01T09:00:00.000Z", backedUp: false },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/publicKey|credentialID|cred-p-/);
  });

  it("removes a passkey of one's own, but not someone else's, and not from another origin", async () => {
    const remove = (as: string, id: string, headers: Record<string, string> = {}) =>
      h.outcome(async () => settingsAction(await h.signedArgs(h.request("/settings", { as, form: { intent: "delete-passkey", passkeyId: id }, headers }))));
    expect(await remove("hana", "p-kim-1")).toMatchObject({ status: 404 });
    expect(await h.db.select().from(passkey).where(eq(passkey.id, "p-kim-1"))).toHaveLength(1);
    expect(await remove("hana", "p-hana-1", { origin: "https://evil.example" })).toMatchObject({ status: 403 });
    expect(await h.db.select().from(passkey).where(eq(passkey.id, "p-hana-1"))).toHaveLength(1);
    expect(await remove("hana", "p-hana-1")).toMatchObject({ status: 302, location: "/settings?saved=passkey-removed#settings-passkeys" });
    expect(await h.db.select().from(passkey).where(eq(passkey.id, "p-hana-1"))).toHaveLength(0);
    expect(await remove("hana", "no-such-passkey")).toMatchObject({ status: 404 });
  });

  it("refuses every change from another origin before anything is read or changed", async () => {
    const post = (form: Record<string, string | string[]>, headers: Record<string, string>) =>
      h.outcome(() => settingsAction(h.args(h.request("/settings", { as: "hana", form, headers }))));
    const forms: Array<Record<string, string | string[]>> = [
      { intent: "preferences", homeArea: "ja", displayLang: "", readLangs: ["en"] },
      { intent: "preferences", confirmHomeArea: "1", homeArea: "th" },
      { intent: "revoke-ai-links" },
      { intent: "delete-passkey", passkeyId: "p-hana-2" },
    ];
    for (const form of forms) expect(await post(form, { origin: "https://evil.example" }), String(form.intent)).toMatchObject({ status: 403 });
    // Also cover requests without either Origin or Sec-Fetch-Site.
    const bare = new Request("http://localhost:5173/settings", { method: "POST", headers: { cookie: h.request("/", { as: "hana" }).headers.get("cookie")! }, body: new URLSearchParams({ intent: "preferences", confirmHomeArea: "1", homeArea: "th" }) });
    expect(await h.outcome(() => settingsAction(h.args(bare)))).toMatchObject({ status: 403 });
    const [profile] = await h.db.select().from((await import("~/lib/db/schema")).profiles).where(eq((await import("~/lib/db/schema")).profiles.userId, h.ids.hana));
    expect(profile.homeArea).toBe("ja");
    expect(profile.readLangs).toEqual(["ja"]);
    expect(await h.db.select().from(passkey).where(eq(passkey.id, "p-hana-2"))).toHaveLength(1);
  });

  it("is for members only", async () => {
    expect(await h.outcome(async () => (await settingsLoader(h.args(h.request("/settings")))))).toMatchObject({ status: 302, location: "/login?next=%2Fsettings" });
  });

  it("deleting the user deletes the passkeys (and the credential id is unique)", async () => {
    await expect(insertPasskey(h.ids.kim, "p-dup", { credentialID: "cred-p-kim-1" })).rejects.toMatchObject({ cause: { code: "23505" } });
    await h.db.delete(user).where(eq(user.id, h.ids.kim));
    expect(await h.db.select().from(passkey).where(eq(passkey.userId, h.ids.kim))).toHaveLength(0);
  });
});
