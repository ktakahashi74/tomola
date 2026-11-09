import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getAuth } from "~/lib/auth/auth.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { apiTokens, session } from "~/lib/db/schema";
import { authenticateToken, createApiToken } from "~/lib/tokens.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { signingCredential } from "./helpers/signing";
import { createReply, createTopic } from "~/lib/entries.server";
import { hitMemberLimit } from "~/lib/rate-limit.server";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore());
const DAY = 86400_000;

it("rejects an absolute ninety-day session even after a recent sliding refresh, including library session consumers", async () => {
  await h.signIn("absolute_session");
  const id = h.ids.absolute_session;
  const auth = await getAuth();
  await h.db.update(session).set({ createdAt: new Date(Date.now() - 89 * DAY), expiresAt: new Date(Date.now() + 30 * DAY), updatedAt: new Date() }).where(eq(session.userId, id));
  expect(await getSessionUser(h.request("/", { as: "absolute_session" }))).not.toBeNull();
  await h.db.update(session).set({ createdAt: new Date(Date.now() - 90 * DAY - 1) }).where(eq(session.userId, id));
  const request = h.request("/settings", { as: "absolute_session" });
  expect(await auth.api.getSession({ headers: request.headers })).toBeNull();
  expect(await getSessionUser(request)).toBeNull();
  await expect(auth.api.listPasskeys({ headers: request.headers })).rejects.toMatchObject({ statusCode: 401 });
});

it("requests user verification for passkey login options", async () => {
  const options = await (await getAuth()).api.generatePasskeyAuthenticationOptions({ headers: new Headers() });
  expect(options.userVerification).toBe("required");
});

it("refuses a valid non-UV assertion before creating a login session and still accepts a UV assertion", async () => {
  await h.signIn("uv_login");
  const key = await signingCredential(h.db, h.ids.uv_login);
  const auth = await getAuth();
  const attempt = async (uv: boolean) => {
    const { response: options, headers } = await auth.api.generatePasskeyAuthenticationOptions({ headers: new Headers(), returnHeaders: true });
    const cookie = headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return auth.api.verifyPasskeyAuthentication({ headers: new Headers({ cookie }), body: { response: key.assert(options.challenge, { uv }) } });
  };
  const sessions = () => h.db.select().from(session).where(eq(session.userId, h.ids.uv_login));
  const before = (await sessions()).length;
  await expect(attempt(false)).rejects.toBeDefined();
  expect(await sessions()).toHaveLength(before);
  await attempt(true);
  expect(await sessions()).toHaveLength(before + 1);
});

it("defaults PATs to ninety days, supports the explicit durations, and never authenticates expired tokens", async () => {
  await h.signIn("expiry_owner");
  const userId = h.ids.expiry_owner;
  const now = new Date();
  for (const expiresInDays of [undefined, 30, 90, 365, null]) {
    const created = await createApiToken(h.db, userId, { name: `Lifetime ${expiresInDays}`, kind: "read", expiresInDays }, { now });
    if (!created.ok) throw new Error(created.error);
    const days = expiresInDays === undefined ? 90 : expiresInDays;
    expect(created.summary).toMatchObject({ expiresAt: days === null ? null : new Date(now.getTime() + days * DAY) });
    expect(await authenticateToken(h.db, created.token, { now })).toMatchObject({ ok: true });
    if (days !== null) expect(await authenticateToken(h.db, created.token, { now: new Date(now.getTime() + days * DAY) })).toEqual({ ok: false, error: "invalid" });
  }
  // Existing rows without an expiry keep their original lifetime.
  const legacy = await createApiToken(h.db, userId, { name: "Legacy token", kind: "read" }, { now });
  if (!legacy.ok) throw new Error(legacy.error);
  await h.db.update(apiTokens).set({ expiresAt: null }).where(eq(apiTokens.id, legacy.summary.id));
  expect(await authenticateToken(h.db, legacy.token, { now: new Date(now.getTime() + 400 * DAY) })).toMatchObject({ ok: true });
  for (const expiresInDays of [0, 1, 31, "", "forever", false]) expect(await createApiToken(h.db, userId, { name: "Invalid", kind: "read", expiresInDays })).toEqual({ ok: false, error: "invalid_expiry" });
});

it("requires a fresh login to create a PAT and provides a login screen that preserves the destination", async () => {
  await h.signIn("fresh_pat");
  const { action } = await import("~/routes/settings-tokens");
  const { loader: loginLoader, action: loginAction } = await import("~/routes/login");
  await h.db.update(session).set({ createdAt: new Date(Date.now() - 2 * DAY) }).where(eq(session.userId, h.ids.fresh_pat));
  const result = await h.outcome(() => action(h.args(h.request("/settings/tokens", { as: "fresh_pat", form: { name: "Sensitive", kind: "read", intent: "create" } }))));
  expect(result.status).toBe(302);
  const location = result.location!;
  expect(new URL(location, "http://localhost:5173").searchParams.get("next")).toBe("/settings/tokens");
  expect(await loginLoader(h.args(h.request(location, { as: "fresh_pat" })))).toMatchObject({ reauth: true, next: "/settings/tokens", verifying: { purpose: "tokens", email: "fresh_pat@example.com", hasPasskey: false } });
  const sent = await h.outcome(() => loginAction(h.args(h.request(location, { as: "fresh_pat", form: { email: "fresh_pat@example.com", reauth: "1", next: "/settings/tokens" } }))));
  expect(sent.status).not.toBe(302);
  expect(await h.db.select().from(apiTokens).where(eq(apiTokens.userId, h.ids.fresh_pat))).toEqual([]);
  await h.db.update(session).set({ createdAt: new Date() }).where(eq(session.userId, h.ids.fresh_pat));
  expect(await h.outcome(() => action(h.args(h.request("/settings/tokens", { as: "fresh_pat", form: { name: "Confirmed", kind: "read", intent: "create", expiresInDays: "30" } }))))).toMatchObject({ status: 200 });
});

it("shares the sixty edits per hour allowance across topic and reply routes", async () => {
  await h.signIn("edit_quota");
  const userId = h.ids.edit_quota;
  const topic = await createTopic(h.db, userId, { title: "Edit allowance", body: "Original", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, userId, topic.id, { body: "Reply", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  for (let i = 0; i < 59; i++) await hitMemberLimit(h.db, "edit", userId);
  const topicAction = (await import("~/routes/topic-edit")).action;
  const replyAction = (await import("~/routes/reply-edit")).action;
  expect(await h.outcome(() => topicAction(h.args(h.request(`/t/${topic.id}/edit`, { as: "edit_quota", form: { title: "Changed", body: "Revised" }, headers: { origin: "https://attacker.example" } }), { id: String(topic.id) })))).toMatchObject({ status: 403 });
  expect(await h.outcome(() => topicAction(h.args(h.request(`/t/${topic.id}/edit`, { as: "edit_quota", form: { title: "Changed", body: "Revised" } }), { id: String(topic.id) })))).toMatchObject({ status: 302 });
  const denied = await h.outcome(() => replyAction(h.args(h.request(`/c/${reply.id}/edit`, { as: "edit_quota", form: { body: "Over allowance" } }), { id: String(reply.id) })));
  expect(denied).toMatchObject({ status: 429 });
});
