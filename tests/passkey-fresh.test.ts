import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CREDENTIAL_FRESH_MS, isCredentialSessionFresh } from "~/lib/auth/credential-session.server";
import { session } from "~/lib/db/schema";
import { messageMarkup } from "./helpers/message-markup";
import { m } from "~/paraglide/messages.js";
import MemberLayout, { loader as memberLoader } from "~/routes/member-layout";
import { handle as homeHandle } from "~/routes/home";
import { loader as settingsLoader } from "~/routes/settings";
import { action as enrollAction } from "~/routes/passkeys";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("pf_member"); });
afterAll(() => h.restore());

it("treats a session as fresh only inside the credential window and never when its creation time is unusable", () => {
  const now = 1_800_000_000_000;
  expect(isCredentialSessionFresh(new Date(now), now)).toBe(true);
  expect(isCredentialSessionFresh(new Date(now - CREDENTIAL_FRESH_MS), now)).toBe(true);
  expect(isCredentialSessionFresh(new Date(now - CREDENTIAL_FRESH_MS - 1), now)).toBe(false);
  for (const value of [undefined, null, "not a date", NaN, {}]) expect(isCredentialSessionFresh(value, now)).toBe(false);
});

it("tells the layout and settings loaders whether the session is fresh, and sends an older session to email re-verification from the prompt", async () => {
  const renderPrompt = async () => {
    const data = await memberLoader(h.args(h.request("/", { as: "pf_member" })));
    if (data.reader) throw new Error("Expected a member");
    const html = await renderInRouter(() => createElement(MemberLayout, { loaderData: data, params: {}, matches: [] } as never), "/", homeHandle);
    return { data, html };
  };
  const reauth = `href="/login?reauth=1&amp;next=%2F%3Fpasskey%3Dcontinue"`;
  const fresh = await renderPrompt();
  expect(fresh.data.credentialFresh).toBe(true);
  expect(fresh.html).toContain(messageMarkup(m.passkey_prompt_register()));
  expect(fresh.html).not.toContain(reauth);
  expect(await settingsLoader(h.args(h.request("/settings", { as: "pf_member" })))).toMatchObject({ credentialFresh: true });

  await h.db.update(session).set({ createdAt: new Date(Date.now() - CREDENTIAL_FRESH_MS - 60_000) }).where(eq(session.userId, h.ids.pf_member));
  const stale = await renderPrompt();
  expect(stale.data.credentialFresh).toBe(false);
  expect(stale.html).toContain(reauth);
  expect(stale.html).toContain(messageMarkup(m.passkey_prompt_register()));
  expect(await settingsLoader(h.args(h.request("/settings", { as: "pf_member" })))).toMatchObject({ credentialFresh: false });

  // The server check is unchanged: an older session still cannot start a registration.
  const refused = await enrollAction(h.args(new Request("http://localhost:5173/passkeys", {
    method: "POST", headers: { origin: "http://localhost:5173", "content-type": "application/json", cookie: h.request("/", { as: "pf_member" }).headers.get("cookie")! }, body: JSON.stringify({ intent: "options", name: "laptop" }),
  })));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "SESSION_NOT_FRESH" });
});
