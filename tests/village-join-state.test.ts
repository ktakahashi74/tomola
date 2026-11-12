import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import Village, { action, loader } from "~/routes/village";
import { ensureLanguageVillages, villageBySlug } from "~/lib/villages.server";
import { createVillage, endVillage } from "~/lib/village-management.server";
import { setVillageFollow } from "~/lib/village-follows.server";
import { villageMembers } from "~/lib/db/schema";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  h = await setupRouteHarness(); await ensureLanguageVillages(h.db);
  for (const name of ["zjoin_owner", "zjoin_reader", "zjoin_guidance", "zjoin_invited"]) await h.signIn(name, { homeArea: "other", readLangs: ["en"] });
  for (const [slug, kind] of [["join-open", "open"], ["join-invite", "invite_public"], ["join-ended", "invite_public"]] as const) {
    expect((await createVillage(h.db, h.ids.zjoin_owner, { slug, name: slug, kind, description: "Description sentinel" })).ok).toBe(true);
  }
  const village = (await villageBySlug(h.db, "join-invite"))!;
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids.zjoin_invited });
  expect((await setVillageFollow(h.db, h.ids.zjoin_owner, "join-ended", true)).ok).toBe(true);
  expect((await endVillage(h.db, h.ids.zjoin_owner, "join-ended")).ok).toBe(true);
}, 60000);
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
const load = (as?: string, slug = "join-open") => loader(h.args(h.request(`/v/${slug}`, { as }), { slug }));
const post = (as: string, intent: string, slug = "join-open") => h.outcome(() => action(h.args(h.request(`/v/${slug}`, { as, form: { intent } }), { slug })));
const html = async (page: Awaited<ReturnType<typeof load>>) => (await renderInRouter(() => createElement(Village, { loaderData: page } as never), `/v/${page.village.slug}`)).replaceAll("&#x27;", "'");
const head = (rendered: string) => rendered.split("</header>")[0];

it("puts joined state and departure in the header, hides follows, and retains an existing follow after departure", async () => {
  expect(await post("zjoin_reader", "follow")).toMatchObject({ status: 200 });
  await post("zjoin_reader", "join");
  const rendered = await html(await load("zjoin_reader"));
  expect(head(rendered)).toContain(m.village_joined());
  expect(head(rendered)).toContain('value="leave"');
  expect(rendered.split(m.village_joined())).toHaveLength(2);
  expect(rendered).not.toMatch(/value="(?:unfollow|follow)"|data-village-participation-help/);
  expect(head(rendered)).toContain('href="/t/new?village=join-open"');
  expect(head(rendered)).not.toContain(m.village_leave_invite_help());
  await post("zjoin_reader", "leave");
  const departed = await load("zjoin_reader");
  expect(departed.following).toBe(true);
  expect(await html(departed)).toContain('value="unfollow"');
  expect(await html(departed)).not.toContain("data-village-participation-help");
  await post("zjoin_reader", "unfollow");
});

it("shows participation guidance before the description only for members who neither joined nor followed", async () => {
  const open = await html(await load("zjoin_guidance"));
  expect(open).toContain(m.village_join_follow_help_chat());
  expect(open.indexOf("data-village-participation-help")).toBeLessThan(open.indexOf("Description sentinel"));
  vi.stubEnv("VILLAGE_CHAT", "");
  try {
    const withoutChat = await html(await load("zjoin_guidance"));
    expect(withoutChat).toContain(m.village_join_follow_help());
    expect(withoutChat).not.toContain(m.village_join_follow_help_chat());
  } finally { vi.stubEnv("VILLAGE_CHAT", "1"); }
  const invite = await html(await load("zjoin_guidance", "join-invite"));
  expect(invite).toContain(m.village_follow_members_help());
  expect(invite).not.toContain('value="join"');
  await post("zjoin_guidance", "follow", "join-invite");
  expect(await html(await load("zjoin_guidance", "join-invite"))).not.toContain("data-village-participation-help");
});

it("retains invitation-only departure confirmation and explains the last owner's disabled action inside the disclosure", async () => {
  const invited = head(await html(await load("zjoin_invited", "join-invite")));
  expect(invited).toContain(m.village_leave_confirm());
  expect(invited).toContain(m.village_leave_invite_help());
  const owner = head(await html(await load("zjoin_owner", "join-invite")));
  expect(owner).toMatch(/<button[^>]*disabled=""[^>]*value="leave"|<button[^>]*value="leave"[^>]*disabled=""/);
  expect(owner).toContain(m.village_error_last_owner());
  expect(await post("zjoin_owner", "leave", "join-invite")).toMatchObject({ status: 400, value: { data: { error: "last_owner" } } });
});

it("lets the last owner leave an ended village without posting, following or invitation confirmation", async () => {
  const rendered = head(await html(await load("zjoin_owner", "join-ended")));
  expect(rendered).toContain(m.village_joined());
  expect(rendered).toContain('value="leave"');
  expect(rendered).not.toMatch(/disabled=""|value="follow"|data-village-participation-help|href="\/t\/new/);
  expect(rendered).not.toContain(m.village_leave_invite_help());
  await post("zjoin_owner", "leave", "join-ended");
  expect((await load("zjoin_owner", "join-ended")).membership?.joined).toBe(false);
  const departed = await html(await load("zjoin_owner", "join-ended"));
  expect(departed).toContain('value="unfollow"');
  expect(departed).not.toContain("data-village-participation-help");
  expect(await html(await load("zjoin_reader", "join-ended"))).not.toContain("data-village-participation-help");
});

it("omits membership actions and participation guidance for anonymous readers", async () => {
  for (const slug of ["join-open", "join-invite"]) {
    const rendered = head(await html(await load(undefined, slug)));
    expect(rendered).not.toMatch(/data-village-participation-help|value="(?:join|leave|follow|unfollow)"/);
    expect(rendered).not.toContain(m.village_joined());
  }
});
