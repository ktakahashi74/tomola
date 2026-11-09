import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createElement } from "react";
import { and, eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { entries, villageFollows, villageMembers, villages } from "~/lib/db/schema";
import { createTopic, listTopics } from "~/lib/entries.server";
import { createVillage } from "~/lib/village-management.server";
import { ensureLanguageVillages, villageBySlug, villageForTopic } from "~/lib/villages.server";
import { followedVillageNavigation, listFollowedVillages } from "~/lib/village-follows.server";
import { buildMemberExport, MEMBER_EXPORT_VERSION } from "~/lib/exports.server";
import { buildListMarkdown } from "~/lib/md/lists.server";
import { getProfile } from "~/lib/profiles.server";
import { hitMemberLimit } from "~/lib/rate-limit.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { PlaceList } from "~/components/place-navigation";
import { action as villageAction, loader as villageLoader } from "~/routes/village";
import { loader as homeLoader } from "~/routes/home";
import { loader as followingLoader } from "~/routes/following";
import { loader as layoutLoader } from "~/routes/member-layout";

// Following a village: reading only. Who can follow what, what it does not give, what the home's list and the places list show, and that the member's data
// (export, deletion) covers it.
let h: RouteHarness;
const topicIds: Record<string, number> = {};
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("ENABLED_LANGS", "en,ja");
  h = await setupRouteHarness();
  await ensureLanguageVillages(h.db);
  for (const name of ["vf_owner", "vf_reader", "vf_loner", "vf_quitter", "vf_limited"]) await h.signIn(name, { homeArea: "en" });
  for (const [slug, kind] of [["follow-club", "open"], ["other-club", "open"], ["invite-club", "invite_public"]] as const)
    expect(await createVillage(h.db, h.ids.vf_owner, { slug, name: `Village ${slug}`, description: "x", kind })).toEqual({ ok: true, slug });
  await h.db.insert(villages).values([{ slug: "secret-club", kind: "closed", name: "Secret" }, { slug: "gone-club", kind: "open", name: "Gone", endedAt: new Date() }]);
  const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 0, minutes));
  const make = async (key: string, who: string, village: string, minutes: number) => {
    const res = await createTopic(h.db, h.ids[who], { lang: "en", title: `Topic ${key}`, body: `Body of ${key}.`, village }, { now: at(minutes) });
    if (!res.ok) throw new Error(`topic ${key}: ${res.error}`);
    topicIds[key] = res.id;
  };
  await make("followed", "vf_owner", "follow-club", 1);
  await make("other", "vf_owner", "other-club", 2);
  await make("invited", "vf_owner", "invite-club", 3);
  await make("language", "vf_reader", "en", 4);
});
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja"); });
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

const post = (as: string | undefined, slug: string, form: Record<string, string>) => h.outcome(() => villageAction(h.args(h.request(`/v/${slug}`, { as, form }), { slug })));
const rows = (who: string) => h.db.select({ villageId: villageFollows.villageId }).from(villageFollows).where(eq(villageFollows.userId, h.ids[who]));
const idOf = async (slug: string) => (await villageBySlug(h.db, slug))?.id ?? (await h.db.select({ id: villages.id }).from(villages).where(eq(villages.slug, slug)))[0].id;

it("follows and unfollows a readable village, again and again without a second row, and refuses a closed or ended one", async () => {
  expect(await post("vf_reader", "follow-club", { intent: "follow" })).toMatchObject({ status: 200, value: { ok: true } });
  expect(await post("vf_reader", "follow-club", { intent: "follow" })).toMatchObject({ status: 200 });
  expect(await rows("vf_reader")).toHaveLength(1);
  // A village that anyone may read in any of its kinds, the language villages and the ones with an invitation included.
  for (const slug of ["en", "invite-club"]) expect(await post("vf_reader", slug, { intent: "follow" })).toMatchObject({ status: 200 });
  expect(await rows("vf_reader")).toHaveLength(3);
  // Closed: answers like a village that does not exist. Ended: cannot be newly followed.
  for (const slug of ["secret-club", "gone-club", "absent-club"]) expect(await post("vf_reader", slug, { intent: "follow" })).toMatchObject({ status: 404 });
  expect(await rows("vf_reader")).toHaveLength(3);
  expect(await post("vf_reader", "invite-club", { intent: "unfollow" })).toMatchObject({ status: 200 });
  expect(await post("vf_reader", "invite-club", { intent: "unfollow" })).toMatchObject({ status: 200 });
  expect(await rows("vf_reader")).toHaveLength(2);
  // An old follow of a village that ended can still be taken off, and a closed village is never touched.
  await h.db.insert(villageFollows).values({ userId: h.ids.vf_reader, villageId: await idOf("gone-club") });
  expect(await post("vf_reader", "gone-club", { intent: "unfollow" })).toMatchObject({ status: 200 });
  await h.db.insert(villageFollows).values({ userId: h.ids.vf_reader, villageId: await idOf("secret-club") });
  expect(await post("vf_reader", "secret-club", { intent: "unfollow" })).toMatchObject({ status: 404 });
  expect(await rows("vf_reader")).toHaveLength(3);
  await h.db.delete(villageFollows).where(eq(villageFollows.villageId, await idOf("secret-club")));
});

it("needs a member who may write, the same origin and a known intent, and goes back only to a local path", async () => {
  expect(await post(undefined, "follow-club", { intent: "follow" })).toMatchObject({ status: 302 });
  expect(await h.outcome(() => villageAction(h.args(h.request("/v/follow-club", { as: "vf_reader", form: { intent: "follow" }, headers: { origin: "https://other.example" } }), { slug: "follow-club" })))).toMatchObject({ status: 403 });
  expect(await post("vf_reader", "follow-club", { intent: "unfollow", returnTo: "/following" })).toMatchObject({ status: 302, location: "/following" });
  expect(await post("vf_reader", "follow-club", { intent: "follow", returnTo: "//evil.example/x" })).toMatchObject({ status: 302, location: "/" });
  expect(await post("vf_reader", "follow-club", { intent: "unfollow", returnTo: "https://evil.example/" })).toMatchObject({ status: 302, location: "/" });
  // Only the language village is left of what the reader followed.
  expect(await rows("vf_reader")).toHaveLength(1);
});

it("limits how often a member follows, and stops when villages are closed", async () => {
  for (let i = 0; i < 60; i++) await hitMemberLimit(h.db, "village-follow", h.ids.vf_limited);
  expect(await post("vf_limited", "follow-club", { intent: "follow" })).toMatchObject({ status: 429 });
  expect(await rows("vf_limited")).toHaveLength(0);
  vi.stubEnv("VILLAGES", "");
  expect(await post("vf_reader", "follow-club", { intent: "follow" })).toMatchObject({ status: 404 });
});

it("gives no right to write or to chat, and the village page only says whether this member follows", async () => {
  await post("vf_loner", "other-club", { intent: "unfollow" });
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_loner));
  await h.db.insert(villageFollows).values({ userId: h.ids.vf_loner, villageId: await idOf("other-club") });
  expect(await h.db.select().from(villageMembers).where(and(eq(villageMembers.userId, h.ids.vf_loner), eq(villageMembers.villageId, await idOf("other-club"))))).toEqual([]);
  expect(await villageForTopic(h.db, h.ids.vf_loner, "other-club")).toBeNull();
  expect(await createTopic(h.db, h.ids.vf_loner, { lang: "en", title: "Not allowed", body: "No.", village: "other-club" })).toEqual({ ok: false, error: "village_required" });
  const page = await villageLoader(h.args(h.request("/v/other-club", { as: "vf_loner" }), { slug: "other-club" })) as unknown as { following: boolean; membership: { joined: boolean; owner: boolean } };
  expect(page.following).toBe(true);
  expect(page.membership).toMatchObject({ joined: false, owner: false });
  vi.stubEnv("PUBLIC_READING", "1");
  const guest = await villageLoader(h.args(h.request("/v/other-club"), { slug: "other-club" })) as unknown as { following: boolean };
  expect(guest.following).toBe(false);
  vi.stubEnv("PUBLIC_READING", "");
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_loner));
});

it("lists the posts of the villages followed or joined, in both orders, and never a closed, ended or unfollowed village's", async () => {
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_reader));
  for (const slug of ["follow-club", "invite-club"]) await post("vf_reader", slug, { intent: "follow" });
  // A topic in a closed village and in an ended one, both followed: not listed.
  const [secret] = await h.db.insert(entries).values({ kind: "topic", authorId: h.ids.vf_owner, lang: "en", title: "Closed topic", body: "Closed.", villageId: await idOf("secret-club") }).returning();
  const [gone] = await h.db.insert(entries).values({ kind: "topic", authorId: h.ids.vf_owner, lang: "en", title: "Ended topic", body: "Ended.", villageId: await idOf("gone-club") }).returning();
  await h.db.insert(villageFollows).values([{ userId: h.ids.vf_reader, villageId: await idOf("secret-club") }, { userId: h.ids.vf_reader, villageId: await idOf("gone-club") }]);
  for (const order of ["created", "activity"] as const) {
    const ids = (await listTopics(h.db, { kind: "my-villages", userId: h.ids.vf_reader }, { order })).topics.map(t => t.id).sort();
    expect(ids).toEqual([topicIds.followed, topicIds.invited, topicIds.language].sort());
    expect(ids).not.toContain(secret.id);
    expect(ids).not.toContain(gone.id);
    expect(ids).not.toContain(topicIds.other);
  }
  // Someone who follows nothing sees only the villages joined (the language village from signing up).
  expect((await listTopics(h.db, { kind: "my-villages", userId: h.ids.vf_quitter })).topics.map(t => t.id)).toEqual([topicIds.language]);
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_reader));
  await h.db.delete(entries).where(and(eq(entries.authorId, h.ids.vf_owner), eq(entries.title, "Closed topic")));
  await h.db.delete(entries).where(and(eq(entries.authorId, h.ids.vf_owner), eq(entries.title, "Ended topic")));
});

type HomeData = { filter: string; followingAvailable: boolean; noVillagePlaces: boolean; topics: Array<{ id: number }> };
const home = async (path: string, as?: string) => await homeLoader(h.args(h.request(path, { as }))) as unknown as HomeData;

it("filters the home to the followed and joined villages for a member only; asks and a closed setting win over it", async () => {
  await post("vf_reader", "follow-club", { intent: "follow" });
  const all = await home("/", "vf_reader");
  expect(all).toMatchObject({ filter: "all", followingAvailable: true });
  expect(all.topics.map(t => t.id).sort()).toEqual(Object.values(topicIds).sort());
  const following = await home("/?follow=1", "vf_reader");
  expect(following).toMatchObject({ filter: "following", noVillagePlaces: false });
  expect(following.topics.map(t => t.id).sort()).toEqual([topicIds.followed, topicIds.language].sort());
  // The default of the home does not change; a reader without an account has no such list.
  vi.stubEnv("PUBLIC_READING", "1");
  const guest = await home("/?follow=1");
  expect(guest).toMatchObject({ filter: "all", followingAvailable: false });
  expect(guest.topics).toHaveLength(Object.keys(topicIds).length);
  vi.stubEnv("PUBLIC_READING", "");
  expect((await home("/?follow=1&asks=1", "vf_reader")).filter).toBe("asks");
  vi.stubEnv("VILLAGES", "");
  expect(await home("/?follow=1", "vf_reader")).toMatchObject({ filter: "all", followingAvailable: false });
  vi.stubEnv("VILLAGES", "1");
  // No village to read from at all: the list says so (the page tells what to do).
  await h.db.delete(villageMembers).where(eq(villageMembers.userId, h.ids.vf_quitter));
  expect(await home("/?follow=1", "vf_quitter")).toMatchObject({ filter: "following", noVillagePlaces: true, topics: [] });
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_reader));
});

it("shows the followed villages with the most recently active first, in the places list, folded after eight", async () => {
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_loner));
  await post("vf_loner", "other-club", { intent: "follow" });
  await post("vf_loner", "follow-club", { intent: "follow" });
  await post("vf_loner", "invite-club", { intent: "follow" });
  expect((await listFollowedVillages(h.db, h.ids.vf_loner)).map(v => v.slug)).toEqual(["invite-club", "other-club", "follow-club"]);
  const layout = await layoutLoader({ request: h.request("/", { as: "vf_loner" }) }) as unknown as { followedVillages: Array<{ slug: string }> };
  expect(layout.followedVillages.map(v => v.slug)).toEqual(["invite-club", "other-club", "follow-club"]);
  const page = await followingLoader(h.args(h.request("/following", { as: "vf_loner" })));
  expect(page).not.toHaveProperty("followedVillages");
  // A village that is also joined stands in the joined group only (in the places list), without changing the follow itself.
  await h.db.insert(villageMembers).values({ villageId: await idOf("other-club"), userId: h.ids.vf_loner });
  expect((await followedVillageNavigation(h.db, h.ids.vf_loner, undefined, { excludeJoined: true })).map(v => v.slug)).toEqual(["invite-club", "follow-club"]);
  expect((await layoutLoader({ request: h.request("/", { as: "vf_loner" }) }) as unknown as { followedVillages: Array<{ slug: string }> }).followedVillages.map(v => v.slug)).toEqual(["invite-club", "follow-club"]);
  expect((await listFollowedVillages(h.db, h.ids.vf_loner)).map(v => v.slug)).toContain("other-club");
  await h.db.delete(villageMembers).where(and(eq(villageMembers.villageId, await idOf("other-club")), eq(villageMembers.userId, h.ids.vf_loner)));
  const places = await followedVillageNavigation(h.db, h.ids.vf_loner);
  const render = (list: typeof places, path = "/") => renderInRouter(() => createElement(PlaceList, { villages: [], followedVillages: list, followedUnread: false, pathname: path }), path);
  const few = await render(places);
  expect(few.match(/href="\/v\/[a-z-]+"/g)).toHaveLength(3);
  expect(few).not.toContain("<details");
  const many = Array.from({ length: 11 }, (_, i) => ({ moreLabel: i === 0 ? "More places" : undefined, name: `Many ${i}`, slug: `many-${i}`, kind: "open", language: null }));
  const folded = await render(many);
  expect(folded.match(/<details/g)).toHaveLength(1);
  const [before, inside] = folded.split("<details");
  expect(before.match(/href="\/v\/many-/g)).toHaveLength(8);
  expect(inside.match(/href="\/v\/many-/g)).toHaveLength(3);
  expect(inside).not.toContain('href="/following"');
  // The village the reader is in stays in sight even when it is among the folded ones.
  expect(await render(many, "/v/many-10")).toMatch(/<details[^>]* open/);
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_loner));
});

it("keeps villages out of the Markdown post list and retains them in the member's own export", async () => {
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_loner));
  await post("vf_loner", "follow-club", { intent: "follow" });
  await h.db.insert(villageFollows).values({ userId: h.ids.vf_loner, villageId: await idOf("secret-club") });
  const profile = (await getProfile(h.db, h.ids.vf_loner))!;
  const first = await buildListMarkdown(h.db, profile, { kind: "following" }, { page: 1, lang: null, k: null });
  expect(first).not.toContain("/v/follow-club");
  expect(first).not.toContain("secret-club");
  expect(await buildListMarkdown(h.db, profile, { kind: "following" }, { page: 2, lang: null, k: null })).not.toContain("/v/follow-club");
  vi.stubEnv("VILLAGES", "");
  expect(await buildListMarkdown(h.db, profile, { kind: "following" }, { page: 1, lang: null, k: null })).not.toContain("/v/follow-club");
  vi.stubEnv("VILLAGES", "1");
  const out = await buildMemberExport(h.db, h.ids.vf_loner);
  expect(out.version).toBe(MEMBER_EXPORT_VERSION);
  expect(out.village_follows).toEqual([{ village: "follow-club", created_at: expect.any(String) }]);
  expect(JSON.stringify(out)).not.toContain("secret-club");
  await h.db.delete(villageFollows).where(eq(villageFollows.userId, h.ids.vf_loner));
});

it("removes the follows with the account, leaving the village and what others follow", async () => {
  await post("vf_quitter", "follow-club", { intent: "follow" });
  await post("vf_reader", "follow-club", { intent: "follow" });
  expect(await rows("vf_quitter")).toHaveLength(1);
  const result = await deleteAccount(h.db, h.ids.vf_quitter, { confirmation: "vf_quitter" });
  expect(result.ok).toBe(true);
  expect(await h.db.select().from(villageFollows).where(eq(villageFollows.villageId, await idOf("follow-club")))).toHaveLength(1);
  expect(await rows("vf_reader")).toHaveLength(1);
  expect(await villageBySlug(h.db, "follow-club")).not.toBeNull();
});
