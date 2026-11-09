import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { session } from "~/lib/db/schema";
import { getAuth } from "~/lib/auth/auth.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { action as settingsAction } from "~/routes/settings";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("devices"); await h.signIn("other"); });
afterAll(() => h.restore());
it("creates a thirty-day session", async () => {
  const [row] = await h.db.select().from(session).where(eq(session.userId, h.ids.devices));
  expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(29.99 * 86400_000);
  expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 86400_000);
});
it("revokes other devices only, preserving the current browser and other members", async () => {
  const token = await h.issueLink("devices@example.com");
  const response = await (await getAuth()).api.magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true });
  const cookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const another = h.request("/", { headers: { cookie } });
  expect(await getSessionUser(another)).not.toBeNull();
  const form = h.request("/settings", { as: "devices", form: { intent: "revoke-other-sessions" } });
  expect((await h.outcome(() => settingsAction(h.args(form)))).location).toBe("/settings?saved=sessions#settings-sessions");
  expect(await getSessionUser(h.request("/", { headers: { cookie } }))).toBeNull();
  expect(await getSessionUser(h.request("/", { as: "devices" }))).not.toBeNull();
  expect(await getSessionUser(h.request("/", { as: "other" }))).not.toBeNull();
});
it("rejects cross-site device revocation", async () => {
  expect((await h.outcome(() => settingsAction(h.args(h.request("/settings", { as: "devices", form: { intent: "revoke-other-sessions" }, headers: { origin: "https://evil.example" } }))))).status).toBe(403);
});
