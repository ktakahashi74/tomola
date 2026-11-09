import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOpenInAiToken, verifyOpenInAiToken } from "~/lib/open-in-ai.server";
import { authenticateToken, createApiToken, listApiTokens, MAX_ACTIVE_TOKENS } from "~/lib/tokens.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana");
  await h.signIn("somchai");
  await h.signIn("kim");
});
afterAll(() => h.restore());

const tokens = () => import("~/routes/settings-tokens");
const act = async (as: string | undefined, form: Record<string, string>, headers: Record<string, string> = {}) =>
  h.outcome(async () => (await tokens()).action(h.args(h.request("/settings/tokens", { as, form, headers }))));
// Extract the contents from data()'s { data, init } return value.
const payload = (value: unknown) => (value as { data: Record<string, unknown> }).data;

describe("/settings/tokens", () => {
  it("requires a login for the page and for both actions", async () => {
    expect(await h.outcome(async () => (await (await tokens()).loader(h.args(h.request("/settings/tokens")))))).toMatchObject({ status: 302, location: "/login?next=%2Fsettings%2Ftokens" });
    expect(await act(undefined, { intent: "create", name: "x", kind: "read" })).toMatchObject({ status: 302, location: "/login" });
    expect(await act(undefined, { intent: "revoke", tokenId: "1" })).toMatchObject({ status: 302, location: "/login" });
  });

  it("refuses a cross-origin POST (creating and revoking)", async () => {
    expect((await act("hana", { intent: "create", name: "x", kind: "read" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await act("hana", { intent: "revoke", tokenId: "1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await listApiTokens(h.db, h.ids.hana)).toEqual([]);
  });

  it("asks the browser not to store any response of the page (a document response may contain the plaintext)", async () => {
    expect((await tokens()).headers()).toEqual({ "Cache-Control": "no-store" });
  });

  it("creates a token, shows the plaintext only in that response, and never lists it", async () => {
    const created = await act("hana", { intent: "create", name: "my tool", kind: "read" });
    expect(created.status).toBe(200);
    const data = payload(created.value);
    expect(data).toMatchObject({ intent: "create", error: null, name: "my tool", token: expect.stringMatching(/^tml_read_[A-Za-z0-9_-]{43}$/) });
    expect((created.value as { init: { headers: Record<string, string> } }).init.headers["Cache-Control"]).toBe("no-store");
    const plaintext = data.token as string;
    const { loader } = await tokens();
    const page = (await loader(h.args(h.request("/settings/tokens", { as: "hana" })))) as unknown as { tokens: Array<{ name: string; kind: string }> };
    expect(page.tokens.map((t) => [t.name, t.kind])).toEqual([["my tool", "read"]]);
    expect(JSON.stringify(page)).not.toContain(plaintext);
    expect((await authenticateToken(h.db, plaintext)).ok).toBe(true);
    // It is absent from other members' lists.
    const other = (await loader(h.args(h.request("/settings/tokens", { as: "somchai" })))) as unknown as { tokens: unknown[] };
    expect(other.tokens).toEqual([]);
  });

  it("rejects a bad name, a bad kind and an unknown intent with a message code", async () => {
    for (const form of [{ intent: "create", name: "", kind: "read" }, { intent: "create", name: "x".repeat(61), kind: "read" }, { intent: "create", name: "a\nb", kind: "read" }]) {
      const res = await act("hana", form);
      expect(res.status).toBe(400);
      expect(payload(res.value)).toMatchObject({ error: "invalid_name", token: null });
    }
    const badKind = await act("hana", { intent: "create", name: "ok", kind: "write" });
    expect(payload(badKind.value)).toMatchObject({ error: "invalid_kind" });
    expect(payload((await act("hana", { name: "ok" })).value)).toMatchObject({ error: "invalid_kind" });
  });

  it("stops at 20 active tokens and says so", async () => {
    for (let i = (await listApiTokens(h.db, h.ids.somchai)).length; i < MAX_ACTIVE_TOKENS; i++) await createApiToken(h.db, h.ids.somchai, { name: `t${i}`, kind: "draft" });
    const res = await act("somchai", { intent: "create", name: "one more", kind: "read" });
    expect(res.status).toBe(400);
    expect(payload(res.value)).toMatchObject({ error: "too_many_tokens" });
  });

  it("revokes only the member's own token: someone else's id is a 404 and leaves the token working (IDOR)", async () => {
    const mine = await createApiToken(h.db, h.ids.hana, { name: "to revoke", kind: "read" });
    const theirs = await createApiToken(h.db, h.ids.kim, { name: "theirs", kind: "read" });
    if (!mine.ok || !theirs.ok) throw new Error("token failed");
    const attack = await act("hana", { intent: "revoke", tokenId: String(theirs.summary.id) });
    expect(attack.status).toBe(404);
    expect((await listApiTokens(h.db, h.ids.kim))[0].revokedAt).toBeNull();
    expect((await authenticateToken(h.db, theirs.token)).ok).toBe(true);
    for (const tokenId of ["", "abc", "0", "-1", "1e2", "999999999"]) expect((await act("hana", { intent: "revoke", tokenId })).status, tokenId).toBe(404);
    const ok = await act("hana", { intent: "revoke", tokenId: String(mine.summary.id) });
    expect(ok.status).toBe(200);
    expect(await authenticateToken(h.db, mine.token)).toEqual({ ok: false, error: "invalid" });
    // Repeating the action behaves as if it does not exist.
    expect((await act("hana", { intent: "revoke", tokenId: String(mine.summary.id) })).status).toBe(404);
  });
});

describe("settings: invalidate the Open in AI links", () => {
  it("bumps the generation so links issued before stop working, and the next link works", async () => {
    const before = signOpenInAiToken({ resource: "/latest.md", userId: h.ids.hana, generation: 0 });
    expect((await verifyOpenInAiToken(h.db, before, { resource: "/latest.md" })).ok).toBe(true);
    const { action } = await import("~/routes/settings");
    const outcome = await h.outcome(() => action(h.args(h.request("/settings", { as: "hana", form: { intent: "revoke-ai-links" } }))));
    expect(outcome).toMatchObject({ status: 302, location: "/settings?saved=ai-links#settings-links" });
    expect(await verifyOpenInAiToken(h.db, before, { resource: "/latest.md" })).toEqual({ ok: false, error: "revoked" });
    // New links are signed with the generation current when the button is clicked.
    expect((await verifyOpenInAiToken(h.db, signOpenInAiToken({ resource: "/latest.md", userId: h.ids.hana, generation: 1 }), { resource: "/latest.md" })).ok).toBe(true);
    // Other members' links are unaffected.
    expect((await verifyOpenInAiToken(h.db, signOpenInAiToken({ resource: "/latest.md", userId: h.ids.somchai, generation: 0 }), { resource: "/latest.md" })).ok).toBe(true);
    // A cross-site POST cannot revoke them.
    expect((await h.outcome(() => action(h.args(h.request("/settings", { as: "hana", form: { intent: "revoke-ai-links" }, headers: { origin: "https://evil.example" } }))))).status).toBe(403);
    expect(await h.outcome(() => action(h.args(h.request("/settings", { form: { intent: "revoke-ai-links" } }))))).toMatchObject({ status: 302, location: "/login" });
  });
});
