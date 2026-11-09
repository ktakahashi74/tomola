import { testOperator } from "./helpers/operator";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import Invite, { loader } from "~/routes/invite";
import { createInvitation } from "~/lib/invitations.server";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const publication = vi.hoisted(() => ({ required: false }));
vi.mock("~/lib/notice-sources.server", async original => ({ ...await original<typeof import("~/lib/notice-sources.server")>(), trialParticipationRequired: () => publication.required }));
let h: RouteHarness;
let token: string;
beforeAll(async () => {
  h = await setupRouteHarness();
  token = (await createInvitation(h.db, { email: "notice@example.com" })).token;
});
afterAll(() => h.restore());
afterEach(() => { vi.unstubAllEnvs(); publication.required = false; });

it.each([true, false])("shows the invitation's public-reading notice only when public reading is %s", async enabled => {
  vi.stubEnv("PUBLIC_READING", enabled ? "1" : "");
  const loaderData = await loader(h.args(h.request(`/invite/${token}`), { token }));
  const html = await renderInRouter(() => createElement(Invite, { loaderData } as never), `/invite/${token}`);
  expect(html.includes(m.public_reading_onboarding())).toBe(enabled);
});

it.each([true, false])("shows plain residence restrictions only when trial participation is required: %s", async required => {
  publication.required = required;
  const loaderData = await loader(h.args(h.request(`/invite/${token}`), { token }));
  const html = await renderInRouter(() => createElement(Invite, { loaderData } as never), `/invite/${token}`);
  expect(html).not.toContain('href="/terms#s2"');
  expect(html.includes(testOperator.participation.copy.en.invitationRestriction)).toBe(required);
  if (required) expect(html.indexOf(testOperator.participation.copy.en.invitationRestriction)).toBeLessThan(html.indexOf(m.invite_submit()));
});
