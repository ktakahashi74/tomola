import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { action, loader } from "~/routes/settings-delete-account";
import { action as signingAction } from "~/routes/signing";
import { setupRouteHarness, type RouteHarness, BASE } from "./helpers/route-harness";
import { attachSigningProof, signingCredential } from "./helpers/signing";
import { apiTokens, oauthClient, oauthConsent, oauthRefreshToken, passkey, profiles, user } from "~/lib/db/schema";
import { getAuth } from "~/lib/auth/auth.server";
import { createApiToken, authenticateToken } from "~/lib/tokens.server";
import { signOpenInAiToken, verifyOpenInAiToken } from "~/lib/open-in-ai.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { withMcpAuth } from "~/lib/mcp/auth.server";
let h: RouteHarness | undefined;
afterEach(() => h?.restore());

it("requires a member, exact confirmation and same-origin POSTs", async () => {
  h = await setupRouteHarness(); await h.signIn("quit_route");
  const form = { intent: "delete-account", confirmation: "quit_route" };
  expect((await h.outcome(() => loader(h!.args(h!.request("/settings/delete-account"))))).status).toBe(302);
  expect((await h.outcome(() => action(h!.args(h!.request("/settings/delete-account", { as: "quit_route", form, headers: { origin: "https://other.example" } }))))).status).toBe(403);
  expect((await h.outcome(() => action(h!.args(h!.request("/settings/delete-account", { as: "quit_route", form: { ...form, confirmation: "wrong" } }))))).status).toBe(400);
  expect(await h.db.select().from(user).where(eq(user.id, h.ids.quit_route))).toHaveLength(1);
});

it("blocks an unsigned opted-in deletion and accepts real UV proof even while suspended", async () => {
  h = await setupRouteHarness(); const id = await h.signIn("quit_signed");
  const credential = await signingCredential(h.db, id);
  await h.db.update(profiles).set({ signPosts: true, suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, id));
  const request = () => h!.request("/settings/delete-account", { as: "quit_signed", form: { intent: "delete-account", confirmation: "quit_signed", posts: "keep" } });
  expect((await h.outcome(() => action(h!.args(request())))).status).toBe(403);
  const previewRequest = new Request(`${BASE}/signing`, { method: "POST", headers: { origin: BASE, cookie: request().headers.get("cookie")!, "content-type": "application/json" }, body: JSON.stringify({ intent: "preview", pathname: "/settings/delete-account", fields: [...new URLSearchParams({ intent: "delete-account", confirmation: "quit_signed", posts: "keep" })] }) });
  expect((await signingAction(h.args(previewRequest))).status).toBe(200);
  const signed = await attachSigningProof(h.db, id, request(), credential);
  const result = await h.outcome(() => action(h!.args(signed)));
  expect(result).toMatchObject({ status: 302, location: "/login?account-deleted=1" });
  expect(await h.db.select().from(passkey).where(eq(passkey.userId, id))).toEqual([]);
  expect((await h.outcome(() => loader(h!.args(h!.request("/settings/delete-account", { as: "quit_signed" }))))).location).toContain("/login");
});

it("invalidates the old session, PAT, read API, MCP bearer, OAuth consent/refresh and AI link", async () => {
  h = await setupRouteHarness(); const id = await h.signIn("quit_auth");
  const token = await createApiToken(h.db, id, { name: "Old access", kind: "read" });
  if (!token.ok) throw new Error(token.error);
  const resource = `${BASE}/t/1.md`;
  const link = signOpenInAiToken({ userId: id, generation: 0, resource });
  expect(await verifyOpenInAiToken(h.db, link, { resource })).toMatchObject({ ok: true });
  await h.db.insert(oauthClient).values({ id: "quit-client", clientId: "quit-client", redirectUris: ["https://client.example/cb"] });
  await h.db.insert(oauthConsent).values({ id: "quit-grant", clientId: "quit-client", userId: id, scopes: ["read"], createdAt: new Date(), updatedAt: new Date() });
  await h.db.insert(oauthRefreshToken).values({ id: "quit-refresh", token: "secret-refresh", clientId: "quit-client", userId: id, scopes: ["read"], expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date() });
  const request = h.request("/settings/delete-account", { as: "quit_auth", form: { intent: "delete-account", confirmation: "quit_auth" } });
  expect((await h.outcome(() => action(h!.args(request)))).status).toBe(302);
  expect(await (await getAuth()).api.getSession({ headers: request.headers })).toBeNull();
  expect(await authenticateToken(h.db, token.token)).toMatchObject({ ok: false });
  expect(await verifyOpenInAiToken(h.db, link, { resource })).toMatchObject({ ok: false });
  const bearer = new Request(resource, { headers: { authorization: `Bearer ${token.token}` } });
  const read = await authenticateRead(bearer, "json", { db: h.db });
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.response.status).toBe(401);
  const reached = vi.fn(async () => new Response("should not run"));
  expect((await withMcpAuth(bearer, { db: h.db, auth: await getAuth(), baseURL: BASE }, reached)).status).toBe(401);
  expect(reached).not.toHaveBeenCalled();
  expect(await h.db.select().from(oauthConsent).where(eq(oauthConsent.userId, id))).toEqual([]);
  expect(await h.db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, id))).toEqual([]);
  expect(await h.db.select().from(apiTokens).where(eq(apiTokens.userId, id))).toEqual([]);
});
