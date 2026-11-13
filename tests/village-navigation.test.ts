import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { profiles, villageMembers, villages } from "~/lib/db/schema";
import { memberAvatarUrl } from "~/lib/member-avatar.server";
import { endPersonalVillage } from "~/lib/personal-villages.server";
import * as chat from "~/lib/village-chat.server";
import { loader as navigation } from "~/routes/member-layout";
import { loader as directory } from "~/routes/villages";
import { joinedVillageNavigation } from "~/lib/village-navigation.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  for (const name of ["navigation_reader", "navigation_writer"]) await h.signIn(name);
  const rows = await h.db.insert(villages).values([{ slug: "nav-active", kind: "open" }, { slug: "nav-ended", kind: "open" }, { slug: "nav-outsider", kind: "open" }, { slug: "nav-unconsented", kind: "open" }]).returning();
  await h.db.insert(villageMembers).values(rows.slice(0, 2).flatMap(village => ["navigation_reader", "navigation_writer"].map(name => ({ villageId: village.id, userId: h.ids[name] }))));
  for (const village of rows.slice(0, 2)) {
    for (const name of ["navigation_reader", "navigation_writer"]) await chat.acceptChatConsent(h.db, h.ids[name], village.slug!);
    await chat.mutateChat(h.db, h.ids.navigation_writer, village.slug!, "send", { body: "Shared navigation unread" });
  }
  await h.db.insert(villageMembers).values({ villageId: rows[3].id, userId: h.ids.navigation_reader });
  await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.slug, "nav-ended"));
});
afterAll(() => h.restore());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("returns the member's personal village before active joined villages and counts unread once", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const count = vi.spyOn(chat, "chatUnreadCounts");
  const rows = await joinedVillageNavigation(h.db, h.ids.navigation_reader);
  expect(rows[0]).toMatchObject({ kind: "personal", slug: "@navigation_reader", name: "" });
  expect(rows.filter(row => row.kind === "personal")).toHaveLength(1);
  const [member] = await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.navigation_reader));
  expect(rows[0].iconUrl).toBe(memberAvatarUrl(member));
  expect(rows[0]).not.toHaveProperty("chatAvailable");
  expect(rows.find(row => row.slug === "nav-active")).toMatchObject({ unread: 1, chatAvailable: true });
  expect(rows.some(row => ["nav-ended", "nav-outsider"].includes(row.slug!))).toBe(false);
  expect(rows.find(row => row.slug === "nav-unconsented")).toMatchObject({ unread: 0, chatAvailable: false });
  expect(count).toHaveBeenCalledOnce();
  const lone = await h.signIn("navigation_lone", { homeArea: "other" });
  expect(await joinedVillageNavigation(h.db, lone)).toMatchObject([{ kind: "personal", slug: "@navigation_lone" }]);
  const load = () => directory(h.args(h.request("/villages", { as: "navigation_lone" })));
  expect((await load()).villages.filter(row => row.joined)).toMatchObject([{ kind: "personal", slug: "@navigation_lone" }]);
  await endPersonalVillage(h.db, lone, new Date());
  expect(await joinedVillageNavigation(h.db, lone)).toEqual([]);
  expect((await load()).villages.some(row => row.kind === "personal")).toBe(false);
});
it("counts the unread mentions of the member in each village separately from the unread messages", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  await chat.mutateChat(h.db, h.ids.navigation_writer, "nav-active", "send", { body: "Hello @navigation_reader, a message for you" });
  const rows = await joinedVillageNavigation(h.db, h.ids.navigation_reader);
  expect(rows.find(row => row.slug === "nav-active")).toMatchObject({ unread: 2, mentions: 1 });
  expect(rows.find(row => row.slug === "nav-ended")).toBeUndefined();
});
it("returns village entrances without unread fields or chat counting when the chat flag is absent", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", undefined);
  const count = vi.spyOn(chat, "chatUnreadCounts");
  const rows = await joinedVillageNavigation(h.db, h.ids.navigation_reader);
  expect(rows.some(row => row.slug === "nav-active")).toBe(true);
  expect(rows.every(row => !("unread" in row) && !("chatAvailable" in row))).toBe(true);
  expect(count).not.toHaveBeenCalled();
});
it("performs no village queries when villages are closed", async () => {
  vi.stubEnv("VILLAGES", "");
  const select = vi.spyOn(h.db, "select");
  expect(await joinedVillageNavigation(h.db, h.ids.navigation_reader)).toEqual([]);
  expect(select).not.toHaveBeenCalled();
});

it("sends only village menu fields in the member layout, including while chat is closed", async () => {
  vi.stubEnv("VILLAGES", "1");
  for (const enabled of ["1", ""]) {
    vi.stubEnv("VILLAGE_CHAT", enabled);
    const value = await navigation(h.args(h.request("/", { as: "navigation_reader" })));
    expect(value).toHaveProperty("villages");
    if (!("villages" in value)) throw new Error("No joined navigation");
    expect(value.villages.length).toBeGreaterThan(0);
    for (const row of value.villages) expect(Object.keys(row).sort()).toEqual([...(enabled && row.kind !== "personal" ? ["chatAvailable", "mentions", "unread"] : []), "iconUrl", "kind", "language", "name", "slug"].sort());
  }
});
