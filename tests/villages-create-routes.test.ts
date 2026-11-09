import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { profiles, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { createVillage, inviteToVillage } from "~/lib/village-management.server";
import { changeVillageMembership, ensureLanguageVillages, listJoinedVillages, listVillages } from "~/lib/villages.server";
import { action as createAction, loader as createLoader } from "~/routes/village-create";
import { action as villageAction, loader as villageLoader } from "~/routes/village";
import { loader as directoryLoader } from "~/routes/villages";
import { serveVillageMd, serveVillagesMd } from "~/lib/md/twin.server";
import { loader as layoutLoader } from "~/routes/member-layout";

let h: RouteHarness;
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1");
  h = await setupRouteHarness();
  await ensureLanguageVillages(h.db);
  for (const name of ["vcr_owner", "vcr_guest", "vcr_suspended"]) await h.signIn(name, { homeArea: "en" });
  await h.signIn("vcr_halfway", { profile: false });
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.vcr_suspended));
  await createVillage(h.db, h.ids.vcr_owner, { slug: "route-club", name: "Public invited village", description: "<b>plain description</b>", kind: "invite_public" });
  await h.db.insert(villages).values({ slug: "private-route", kind: "closed", name: "Private" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv("VILLAGES", "1"); });
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
const post = (as: string, form: Record<string, string>, slug = "route-club") => h.outcome(() => villageAction(h.args(h.request(`/v/${slug}`, { as, form }), { slug })));

it("404s before authentication on the creation loader, action and parent when disabled", async () => {
  vi.stubEnv("VILLAGES", "");
  for (const as of [undefined, "vcr_owner", "vcr_halfway"]) {
    for (const call of [() => createLoader(h.args(h.request("/villages/new", { as }))), () => createAction(h.args(h.request("/villages/new", { as, form: { kind: "open" } }))), () => layoutLoader({ request: h.request("/villages/new", { as }) })])
      expect(await h.outcome(call)).toMatchObject({ status: 404 });
  }
});
it("applies writer and same-origin gates on creation and every village management action", async () => {
  expect(await h.outcome(() => createAction(h.args(h.request("/villages/new", { as: "vcr_halfway", form: { name: "No" } }))))).toMatchObject({ status: 302, location: "/onboarding" });
  expect(await h.outcome(() => createAction(h.args(h.request("/villages/new", { as: "vcr_suspended", form: { name: "No" } }))))).toMatchObject({ status: 302, location: "/suspended" });
  expect(await h.outcome(() => createAction(h.args(h.request("/villages/new", { as: "vcr_owner", form: { name: "No" }, headers: { origin: "https://other.example" } }))))).toMatchObject({ status: 403 });
  const membership = () => h.db.select({ villageId: villageMembers.villageId }).from(villageMembers).where(eq(villageMembers.userId, h.ids.vcr_suspended)).orderBy(villageMembers.villageId);
  const originalMembership = await membership();
  const [en] = await h.db.select({ id: villages.id }).from(villages).where(eq(villages.slug, "en"));
  const [ja] = await h.db.select({ id: villages.id }).from(villages).where(eq(villages.slug, "ja"));
  expect(originalMembership).toContainEqual({ villageId: en.id });
  expect(originalMembership).not.toContainEqual({ villageId: ja.id });
  for (const intent of ["add-member", "join", "leave", "post-here", "flag", "edit", "invite", "invite-owner", "cancel-invite", "accept-invite", "decline-invite", "remove-member", "end"]) {
    const slug = intent === "join" ? "ja" : intent === "leave" ? "en" : "route-club";
    expect(await post("vcr_halfway", { intent }, slug)).toMatchObject({ status: 302, location: "/onboarding" });
    expect(await post("vcr_suspended", { intent }, slug)).toMatchObject({ status: 302, location: "/suspended" });
  }
  expect(await membership()).toEqual(originalMembership);
  expect(await post("vcr_guest", { intent: "post-here" })).toMatchObject({ status: 404 });
  expect(await post("vcr_guest", { intent: "join" })).toMatchObject({ status: 404 });
  for (const intent of ["join", "post-here"]) expect(await post("vcr_guest", { intent }, "missing")).toMatchObject({ status: 404 });
  expect(await post("vcr_guest", { intent: "edit", name: "No", description: "" })).toMatchObject({ status: 403 });
  expect(await post("vcr_owner", { intent: "end" })).toMatchObject({ status: 400 });
});
it("shows invited/ended public pages in HTML and Markdown while preserving private metadata boundaries", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  const args = h.args(h.request("/v/route-club"), { slug: "route-club" });
  const page = await villageLoader(args);
  expect(page.village).toMatchObject({ name: "Public invited village", kind: "invite_public" });
  expect(page.village).not.toHaveProperty("id"); expect(page.membership).toBeNull();
  expect(page.management.roster).toEqual([]);
  const directory = await directoryLoader(h.args(h.request("/villages")));
  expect(directory.villages.every(v => !("members" in v) && !("joined" in v) && !("id" in v))).toBe(true);
  expect(directory.villages.some(v => v.slug === "private-route")).toBe(false);
  expect(await h.outcome(() => villageLoader(h.args(h.request("/v/private-route"), { slug: "private-route" })))).toMatchObject({ status: 404 });
  expect((await serveVillageMd(h.request("/v/private-route.md"), "private-route")).status).toBe(404);
  const md = await (await serveVillageMd(h.request("/v/route-club.md"), "route-club")).text();
  expect(md).toContain("<b>plain description</b>"); expect(md).toContain("invite_public");
  const [row] = await h.db.select().from(villages).where(eq(villages.slug, "route-club"));
  expect(md).not.toContain(row.id);
  const indexMd = await (await serveVillagesMd(h.request("/villages.md"))).text();
  expect(indexMd).toContain("Public invited village"); expect(indexMd).not.toContain(row.id); expect(indexMd).not.toContain("members:");
  const outsider = await villageLoader(h.args(h.request("/v/route-club", { as: "vcr_guest" }), { slug: "route-club" }));
  expect(outsider.management.roster).toEqual([]);
  const ending = await post("vcr_owner", { intent: "end", confirm: "end" });
  expect(ending).toMatchObject({ status: 302, location: "/v/route-club?manage=1" });
  expect((await villageLoader(args)).ended).toBe(true);
  expect((await serveVillageMd(h.request("/v/route-club.md"), "route-club")).status).toBe(200);
  expect(await (await serveVillageMd(h.request("/v/route-club.md"), "route-club")).text()).toContain("ended: true");
});
it("creates through the route, receives a private invitation and accepts it through the route", async () => {
  expect(await h.outcome(() => createAction(h.args(h.request("/villages/new", { as: "vcr_owner", form: { slug: "another-route", name: "Another", description: "", kind: "invite_public" } }))))).toMatchObject({ status: 302, location: "/v/another-route" });
  await inviteToVillage(h.db, h.ids.vcr_owner, "another-route", "vcr_guest", "join");
  const [invite] = await h.db.select().from(villageInvites).where(eq(villageInvites.state, "pending"));
  const directory = await directoryLoader(h.args(h.request("/villages", { as: "vcr_guest" })));
  expect(directory.invites).toMatchObject([{ slug: "another-route", inviter: "vcr_owner" }]);
  expect(await post("vcr_guest", { intent: "accept-invite", invite: invite.id }, "another-route")).toMatchObject({ status: 302, location: "/v/another-route" });
  expect(await post("vcr_guest", { intent: "post-here" }, "another-route")).toMatchObject({ status: 302, location: "/t/new?village=another-route" });
});
it("returns the last-owner error on the page and withholds ordinary members' rosters", async () => {
  await createVillage(h.db, h.ids.vcr_owner, { slug: "roster-route", name: "Roster", description: "", kind: "open" });
  expect(await post("vcr_owner", { intent: "leave" }, "roster-route")).toMatchObject({ status: 400, value: { data: { error: "last_owner" } } });
  await changeVillageMembership(h.db, h.ids.vcr_guest, "roster-route", "join");
  const owner = await villageLoader(h.args(h.request("/v/roster-route?membersPage=2", { as: "vcr_owner" }), { slug: "roster-route" }));
  expect(owner.management).toMatchObject({ roster: [], rosterPage: 2, lastOwner: true, canReadRoster: true });
  const member = await villageLoader(h.args(h.request("/v/roster-route", { as: "vcr_guest" }), { slug: "roster-route" }));
  expect(member.membership).toMatchObject({ joined: true, members: 2 });
  expect(member.management).toMatchObject({ roster: [], canReadRoster: false });
  for (const value of ["0", "1e2", "10001"]) expect(await h.outcome(() => villageLoader(h.args(h.request(`/v/roster-route?membersPage=${value}`, { as: "vcr_owner" }), { slug: "roster-route" })))).toMatchObject({ status: 404 });
});

it("limits membership attempts across villages and post-here with the existing member rate headers", async () => {
  await h.signIn("vcr_rate", { homeArea: "other" });
  for (let n = 0; n < 30; n++) {
    expect((await post("vcr_rate", { intent: n % 2 ? "leave" : "join" }, n % 4 < 2 ? "en" : "ja")).status).toBe(200);
  }
  for (const intent of ["join", "leave", "post-here"]) {
    const result = await post("vcr_rate", { intent }, "en");
    expect(result.status).toBe(429);
    expect(result.value).toMatchObject({ data: { error: "rate_limited" }, init: { headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "0", "Retry-After": expect.any(String) } } });
  }
});

it("rejects malformed invitation page numbers", async () => {
  for (const value of ["0", "-1", "1e2", "10001", "bad"]) {
    expect(await h.outcome(() => villageLoader(h.args(h.request(`/v/route-club?invitesPage=${value}`, { as: "vcr_owner" }), { slug: "route-club" })))).toMatchObject({ status: 404 });
  }
});

it("omits villages without slugs from screen and Markdown destinations", async () => {
  const [village] = await h.db.insert(villages).values({ name: "No address village", kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids.vcr_guest });
  for (const userId of [undefined, h.ids.vcr_guest]) expect((await listVillages(h.db, userId)).some(row => row.name === village.name)).toBe(false);
  expect((await listJoinedVillages(h.db, h.ids.vcr_guest)).some(row => row.name === village.name)).toBe(false);
  vi.stubEnv("PUBLIC_READING", "1");
  expect(await (await serveVillagesMd(h.request("/villages.md"))).text()).not.toContain(village.name);
  expect((await serveVillageMd(h.request("/v/null.md"), "null")).status).toBe(404);
});

it("returns management operations to the expanded management section", async () => {
  for (const name of ["vcr_manage_owner", "vcr_manage_target", "vcr_manage_member"]) await h.signIn(name, { homeArea: "en" });
  const slug = "native-route-management";
  expect(await createVillage(h.db, h.ids.vcr_manage_owner, { slug, name: "Native route management", description: "", kind: "invite_public" })).toMatchObject({ ok: true });
  const [village] = await h.db.select().from(villages).where(eq(villages.slug, slug));
  const manage = async (form: Record<string, string>) => {
    expect(await post("vcr_manage_owner", form, slug)).toMatchObject({ status: 302, location: `/v/${slug}?manage=1` });
  };
  await manage({ intent: "edit", name: village.name!, description: "Updated description" });
  await manage({ intent: "invite", handle: "vcr_manage_target" });
  const [invitation] = await h.db.select().from(villageInvites).where(eq(villageInvites.villageId, village.id));
  await manage({ intent: "cancel-invite", invite: invitation.id });
  await manage({ intent: "add-member", handle: "vcr_manage_member" });
  await manage({ intent: "invite-owner", handle: "vcr_manage_member" });
  await manage({ intent: "remove-member", handle: "vcr_manage_member", reason: "Membership no longer needed" });
  await manage({ intent: "end", confirm: "end" });
});
