import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { profiles, rateLimits, villageEvents, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { deleteAccount } from "~/lib/account-delete.server";
import { inviteToVillage, suggestVillageInvitees } from "~/lib/village-management.server";
import { hitMemoryReadLimit, MEMBER_RATE_LIMITS, READ_RATE_LIMIT } from "~/lib/rate-limit.server";
import { VILLAGE_DECLINE_LIMIT, VILLAGE_INVITE_DAILY_LIMIT, VILLAGE_INVITE_PAUSE_DAYS, VILLAGE_REINVITE_HOURS } from "~/lib/villages";
import { loader } from "~/routes/village-invite-suggest";
import { loader as mentions } from "~/routes/mention-suggest";
import { addMember } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let villageId: string;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["is_owner", "is_coowner", "is_member", "is_outside"]) await h.signIn(handle, { homeArea: "en" });
  await h.signIn("is_halfway", { profile: false });
  const [village] = await h.db.insert(villages).values({ slug: "invite-search", kind: "invite_public", name: "Invitation search" }).returning();
  villageId = village.id;
  await h.db.insert(villageMembers).values(["is_owner", "is_coowner", "is_member"].map(handle => ({ villageId, userId: h.ids[handle], role: handle === "is_member" ? "member" : "owner" })));
  for (const [handle, displayName, displayNameLatin] of [
    ["rank", "Ranked exact", null], ["rank_a", null, null], ["rank_z", null, null],
    ["aaa_named", "Ranked name", null], ["zzz_named", null, "Ranked Latin"],
    ["native_name", "小川さくら", "Sakura Ogawa"], ["width_name", "Ａｌｐｈａ ｶﾀｶﾅ", "Beta Writer"],
    ["long_name", "x".repeat(30), null],
    ["astral_name", "𠮷".repeat(30), null],
    ...Array.from({ length: 12 }, (_, i) => [`cap${String(i).padStart(2, "0")}`, "Shared invite candidate", null]),
  ]) {
    await addMember(h.db, `invite-${handle}`, handle!, { homeArea: "en" });
    await h.db.update(profiles).set({ displayName, displayNameLatin }).where(eq(profiles.handle, handle!));
  }
});
beforeEach(async () => {
  vi.stubEnv("VILLAGES", "1");
  await h.db.delete(rateLimits);
  await h.db.delete(villageInvites);
  await h.db.delete(villageEvents);
  await h.db.update(villages).set({ kind: "invite_public", endedAt: null }).where(eq(villages.id, villageId));
  await h.db.update(profiles).set({ suspendedUntil: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => h.restore());

async function ask(query: string, as = "is_owner", slug = "invite-search") {
  const response = await loader(h.args(h.request(`/villages/${slug}/invite-suggest?${new URLSearchParams({ q: query })}`, { as }), { slug }));
  return { response, body: await response.json() as { members: Array<{ handle: string; name: string | null }> } };
}
const handles = async (query: string, as?: string) => (await ask(query, as)).body.members.map(row => row.handle);
const invite = (handle: string, now?: Date) => inviteToVillage(h.db, h.ids.is_owner, "invite-search", handle, "join", now);

it("permits owners and co-owners, refuses other members and visitors, and never caches responses", async () => {
  for (const as of ["is_owner", "is_coowner"]) {
    const { response, body } = await ask("rank", as);
    expect(response.status).toBe(200);
    expect(body.members).toHaveLength(5);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    for (const member of body.members) expect(Object.keys(member).sort()).toEqual(["handle", "name"]);
    expect(JSON.stringify(body)).not.toMatch(/userId|email|homeArea|invite-rank/);
  }
  for (const as of ["is_member", "is_outside", "is_halfway", ""]) {
    const { response, body } = await ask("rank", as);
    expect(response.status).toBe(403);
    expect(body).toEqual({ members: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  const response = await loader(h.args(h.request("/villages/invite-search/invite-suggest?q=rank", { headers: { authorization: "Bearer fixture" } }), { slug: "invite-search" }));
  expect(response.status).toBe(403);
});

it("shares handle and name matching, normalization and ranking with member search", async () => {
  for (const q of ["rank", "RANK", "ＲＡＮＫ"]) expect(await handles(q)).toEqual(["rank", "rank_a", "rank_z", "aaa_named", "zzz_named"]);
  for (const q of ["川さ", "KURA O", "ｓａｋｕｒａ"]) expect(await handles(q)).toEqual(["native_name"]);
  for (const q of ["alpha", "ＡＬＰＨＡ", "カタカナ", "ｶﾀｶﾅ", "ETA W"]) expect(await handles(q)).toEqual(["width_name"]);
  expect((await ask("川さ")).body.members).toEqual([{ handle: "native_name", name: "小川さくら" }]);
  expect(await handles("ank_z")).toEqual([]);
});

it("excludes self, current members, pending invitees and departed accounts before the eight-result limit", async () => {
  await h.db.insert(villageMembers).values({ villageId, userId: "invite-cap00" });
  try {
    await h.db.insert(villageInvites).values({ villageId, userId: "invite-cap01", invitedBy: h.ids.is_coowner, kind: "join" });
    await deleteAccount(h.db, "invite-cap02", { confirmation: "cap02", posts: "keep" });
    expect(await handles("is_owner")).toEqual([]);
    expect(await handles("is_member")).toEqual([]);
    expect(await handles("is_coowner")).toEqual([]);
    expect(await handles("cap")).toEqual(Array.from({ length: 8 }, (_, i) => `cap${String(i + 3).padStart(2, "0")}`));
    for (const target of ["is_owner", "is_member", "cap00", "cap02"]) expect(await invite(target)).toMatchObject({ ok: false, error: "invalid" });
    expect(await invite("cap01")).toMatchObject({ ok: false, error: "pending" });
    expect(await invite("cap03")).toMatchObject({ ok: true });
  } finally { await h.db.delete(villageMembers).where(eq(villageMembers.userId, "invite-cap00")); }
});

it("returns no candidates outside active invitation-only public villages", async () => {
  expect((await ask("rank", "is_owner", "absent")).response.status).toBe(403);
  await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, villageId));
  expect((await ask("rank")).response.status).toBe(403);
  await h.db.update(villages).set({ endedAt: null, kind: "open" }).where(eq(villages.id, villageId));
  expect(await handles("rank")).toEqual([]);
  vi.stubEnv("VILLAGES", "");
  expect((await ask("rank")).response.status).toBe(403);
});

async function responseHistory(state: "accepted" | "declined" | "cancelled", at: Date) {
  const [event] = await h.db.insert(villageEvents).values({ villageId, actorId: "invite-rank", actorHandle: "rank", action: state, detail: {}, createdAt: at }).returning();
  await h.db.insert(villageInvites).values({ villageId, userId: "invite-rank", invitedBy: h.ids.is_owner, kind: "join", state, respondedAt: at, responseEventId: event.id, createdAt: new Date(at.getTime() - 86400000) });
}

it("shares pair cooldowns across villages and invitation kinds, including their exact expiry", async () => {
  const now = new Date(), delay = VILLAGE_REINVITE_HOURS * 3600000;
  const [other] = await h.db.insert(villages).values({ slug: "invite-cooldown", kind: "open", name: "Other" }).returning();
  await h.db.insert(villageInvites).values({ villageId: other.id, userId: "invite-rank", invitedBy: h.ids.is_owner, kind: "owner", state: "cancelled", respondedAt: now, createdAt: new Date(now.getTime() - 86400000) });
  expect(await handles("rank")).not.toContain("rank");
  expect(await handles("rank", "is_coowner")).toContain("rank");
  expect(await invite("rank", new Date(now.getTime() + delay - 1))).toMatchObject({ error: "invite_wait" });
  expect((await suggestVillageInvitees(h.db, h.ids.is_owner, "invite-search", "rank", new Date(now.getTime() + delay - 1)))?.map(row => row.handle)).not.toContain("rank");
  expect((await suggestVillageInvitees(h.db, h.ids.is_owner, "invite-search", "rank", new Date(now.getTime() + delay)))?.map(row => row.handle)).toContain("rank");
  expect(await invite("rank", new Date(now.getTime() + delay))).toMatchObject({ ok: true });
});

it("shares refusal pauses in response-event order and clears the pause after acceptance", async () => {
  const now = new Date(), at = new Date(now.getTime() - 2 * 86400000);
  for (let i = 0; i < VILLAGE_DECLINE_LIMIT; i++) await responseHistory("declined", at);
  expect(await handles("rank")).not.toContain("rank");
  expect(await invite("rank", now)).toMatchObject({ error: "paused" });
  const expires = new Date(at.getTime() + VILLAGE_INVITE_PAUSE_DAYS * 86400000);
  expect((await suggestVillageInvitees(h.db, h.ids.is_owner, "invite-search", "rank", new Date(expires.getTime() - 1)))?.map(row => row.handle)).not.toContain("rank");
  expect((await suggestVillageInvitees(h.db, h.ids.is_owner, "invite-search", "rank", expires))?.map(row => row.handle)).toContain("rank");
  // Timestamps tie; the later response event still breaks the refusal sequence.
  await responseHistory("accepted", at);
  expect(await handles("rank")).toContain("rank");
  expect(await invite("rank", now)).toMatchObject({ ok: true });
});

it("returns no candidates at the shared rolling-day cap without issuing or cancelling invitations", async () => {
  const now = new Date();
  await h.db.insert(villageInvites).values(Array.from({ length: VILLAGE_INVITE_DAILY_LIMIT - 1 }, () => ({ villageId, userId: "invite-rank", invitedBy: h.ids.is_owner, kind: "join", state: "cancelled", createdAt: now, respondedAt: now })));
  await h.db.insert(villageEvents).values({ villageId, actorId: h.ids.is_owner, actorHandle: "is_owner", action: "add_member", detail: {}, createdAt: now });
  const before = await h.db.select().from(villageInvites);
  expect(await handles("native")).toEqual([]);
  expect(await invite("native_name", now)).toMatchObject({ error: "invite_limit" });
  expect(await h.db.select().from(villageInvites)).toEqual(before);
  expect(await handles("native", "is_coowner")).toEqual(["native_name"]);
});

it("reconciles orphaned pending invitations the same way as the action, without mutating them during search", async () => {
  const [orphan] = await h.db.insert(villageInvites).values({ villageId, userId: "invite-rank", invitedBy: h.ids.is_outside, kind: "join" }).returning();
  expect(await handles("rank")).toContain("rank");
  expect((await h.db.select().from(villageInvites).where(eq(villageInvites.id, orphan.id)))[0].state).toBe("pending");
  expect(await invite("rank")).toMatchObject({ ok: true });
  expect((await h.db.select().from(villageInvites).where(eq(villageInvites.id, orphan.id)))[0].state).toBe("cancelled");
});

it("keeps suspended recipients eligible and refuses a suspended sender", async () => {
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.handle, "rank"));
  expect(await handles("rank")).toContain("rank");
  expect(await invite("rank")).toMatchObject({ ok: true });
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.is_owner));
  expect((await ask("native")).response.status).toBe(403);
});

it("accepts one through thirty characters and returns an empty list outside that range", async () => {
  expect(await handles("r")).toContain("rank");
  expect(await handles("x".repeat(30))).toEqual(["long_name"]);
  expect(await handles("𠮷".repeat(30))).toEqual(["astral_name"]);
  for (const query of ["", "x".repeat(31), "Ｒ".repeat(31), "𠮷".repeat(31)]) expect((await ask(query)).body).toEqual({ members: [] });
});

it("uses the existing mention-suggestion allowance and its retry headers", async () => {
  const limit = MEMBER_RATE_LIMITS["mention-suggest"];
  const key = `member:mention-suggest:${h.ids.is_owner}`;
  const windowStart = new Date(Math.floor(Date.now() / (limit.windowSeconds * 1000)) * limit.windowSeconds * 1000);
  await h.db.insert(rateLimits).values({ key, windowStart, count: limit.limit - 1, expiresAt: new Date(windowStart.getTime() + limit.windowSeconds * 1000) });
  expect((await mentions(h.args(h.request("/mentions/suggest?q=rank", { as: "is_owner" })))).status).toBe(200);
  const { response, body } = await ask("rank");
  expect(response.status).toBe(429);
  expect(body).toEqual({ members: [] });
  expect(response.headers.get("retry-after")).toBeTruthy();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await handles("rank", "is_coowner")).toHaveLength(5);
});

it("keeps a browser-read refusal uncached too", async () => {
  const id = await h.signIn("is_read_limit", { homeArea: "en" });
  await h.db.insert(villageMembers).values({ villageId, userId: id, role: "owner" });
  for (let i = 0; i < READ_RATE_LIMIT.limit; i++) hitMemoryReadLimit(h.db, `read:member:${id}`, READ_RATE_LIMIT);
  const { response, body } = await ask("rank", "is_read_limit");
  expect(response.status).toBe(429);
  expect(body).toEqual({ members: [] });
  expect(response.headers.get("retry-after")).toBeTruthy();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
