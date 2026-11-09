import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { invitations, roles } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken } from "~/lib/invitations.server";
import { loader as memberLoader } from "~/routes/member-layout";
import { action, loader } from "~/routes/invites-new";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["invite_member", "invite_operator", "invite_moderator"]) await h.signIn(handle);
  await h.db.insert(roles).values({ userId: h.ids.invite_moderator, role: "moderator", lang: "ja" });
});
afterAll(() => h.restore());
afterEach(() => vi.unstubAllEnvs());

it.each(["invite_member", "invite_moderator"])("hides invitation access from %s when restricted, including revocation", async as => {
  const invitation = await createInvitation(h.db, { email: `${as}_pending@example.com`, createdBy: h.ids[as] });
  const row = (await findValidInvitationByToken(h.db, invitation.token))!;
  vi.stubEnv("OPERATOR_EMAILS", "invite_operator@example.com");
  vi.stubEnv("OPERATOR_ONLY_INVITATIONS", "1");
  expect(await h.outcome(() => loader(h.args(h.request("/invites/new", { as }))))).toMatchObject({ status: 404 });
  const forms: Array<Record<string, string>> = [{ email: `${as}_blocked@example.com` }, { intent: "revoke", id: row.id }];
  for (const form of forms) {
    expect(await h.outcome(() => action(h.args(h.request("/invites/new", { as, form }))))).toMatchObject({ status: 404 });
  }
  expect(await findValidInvitationByToken(h.db, invitation.token)).not.toBeNull();
  expect(await h.db.select().from(invitations).where(eq(invitations.email, `${as}_blocked@example.com`))).toEqual([]);
  expect(await memberLoader(h.args(h.request("/", { as })))).toMatchObject({ canInvite: false, isOperator: false, isModerator: as === "invite_moderator" });
});

it("allows operators to load, create and revoke invitations while restricted", async () => {
  vi.stubEnv("OPERATOR_EMAILS", " INVITE_OPERATOR@EXAMPLE.COM ");
  vi.stubEnv("OPERATOR_ONLY_INVITATIONS", "1");
  const as = "invite_operator";
  expect(await h.outcome(() => loader(h.args(h.request("/invites/new", { as }))))).toMatchObject({ status: 200 });
  const created = await action(h.args(h.request("/invites/new", { as, form: { email: "operator_recipient@example.com" } })));
  expect(created).toMatchObject({ error: null, url: expect.stringContaining("/invite/") });
  const [row] = await h.db.select().from(invitations).where(eq(invitations.email, "operator_recipient@example.com"));
  expect(row.createdBy).toBe(h.ids[as]);
  expect(await action(h.args(h.request("/invites/new", { as, form: { intent: "revoke", id: row.id } })))).toEqual({ url: null, error: null });
  expect((await h.db.select().from(invitations).where(eq(invitations.id, row.id)))[0].revokedAt).not.toBeNull();
  expect(await memberLoader(h.args(h.request("/", { as })))).toMatchObject({ canInvite: true, isOperator: true });
});

it.each([undefined, ""])("keeps member invitation creation and revocation available with setting %s", async setting => {
  vi.stubEnv("OPERATOR_EMAILS", "invite_operator@example.com");
  vi.stubEnv("OPERATOR_ONLY_INVITATIONS", setting);
  const as = "invite_member";
  expect(await h.outcome(() => loader(h.args(h.request("/invites/new", { as }))))).toMatchObject({ status: 200 });
  const email = `member_recipient_${setting === undefined ? "unset" : "empty"}@example.com`;
  expect(await action(h.args(h.request("/invites/new", { as, form: { email } })))).toMatchObject({ error: null, url: expect.stringContaining("/invite/") });
  const [row] = await h.db.select().from(invitations).where(eq(invitations.email, email));
  expect(row.createdBy).toBe(h.ids[as]);
  expect(await action(h.args(h.request("/invites/new", { as, form: { intent: "revoke", id: row.id } })))).toEqual({ url: null, error: null });
  expect(await memberLoader(h.args(h.request("/", { as })))).toMatchObject({ canInvite: true, isOperator: false });
});
