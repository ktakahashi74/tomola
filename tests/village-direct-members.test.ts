import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { chatConsents, jobs, notifications, profiles, villageDepartures, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { createReply, createTopic, getThread } from "~/lib/entries.server";
import { listNotifications, countUnreadNotifications } from "~/lib/notifications.server";
import { notificationDestination } from "~/lib/notification-opening.server";
import { changeVillageMembership, ensureLanguageVillages, villageBySlug } from "~/lib/villages.server";
import { addVillageMember, createVillage, endVillage, inviteToVillage, removeVillageMember, respondToVillageInvite } from "~/lib/village-management.server";
import { VILLAGE_INVITE_DAILY_LIMIT, VILLAGE_REMOVAL_REASON_MAX } from "~/lib/villages";
import { acceptChatConsent, mutateChat } from "~/lib/village-chat.server";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { deleteAccount } from "~/lib/account-delete.server";
import { DELETED_MEMBER_HANDLE } from "~/lib/deleted-member";

afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb(); await ensureLanguageVillages(db);
  for (const id of ["owner", "guest", "second"]) await addMember(db, id, `direct_${id}`, { homeArea: "en" });
  await createVillage(db, "owner", { slug: "direct-club", name: "Direct club", description: "", kind: "invite_public" });
  return { db, village: (await villageBySlug(db, "direct-club"))! };
}

it.each([false, true])("adds without acceptance, preserves the default (empty: %s), notifies and grants posting only", async empty => {
  const { db, village } = await world();
  await db.update(profiles).set({ emailPref: "immediate", ...(empty ? { defaultVillageId: null } : {}) }).where(eq(profiles.userId, "guest"));
  const [before] = await db.select().from(profiles).where(eq(profiles.userId, "guest"));
  expect(await addVillageMember(db, "owner", "direct-club", " @DIRECT_GUEST ")).toEqual({ ok: true, slug: "direct-club" });
  const [after] = await db.select().from(profiles).where(eq(profiles.userId, "guest"));
  expect(after.defaultVillageId).toBe(before.defaultVillageId);
  expect(after.villagePreparedAt).toEqual(before.villagePreparedAt);
  expect(await db.select().from(villageInvites)).toEqual([]);
  expect(await db.select().from(chatConsents).where(and(eq(chatConsents.userId, "guest"), eq(chatConsents.villageId, village.id)))).toEqual([]);
  await acceptChatConsent(db, "owner", "direct-club");
  await mutateChat(db, "owner", "direct-club", "send", { body: "Before consent @direct_guest" });
  expect(await db.select().from(notifications).where(eq(notifications.kind, "chat_mention"))).toEqual([]);
  const notices = (await listNotifications(db, "guest")).items;
  expect(notices).toHaveLength(1); expect(notices[0]).toMatchObject({ kind: "village_added", village: { slug: "direct-club" } });
  expect(await countUnreadNotifications(db, "guest")).toBe(1);
  expect(await notificationDestination(db, "guest", notices[0].id, null)).toBe("/v/direct-club");
  expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, `notification-email:${notices[0].id}`))).toHaveLength(1);
  const topic = await createTopic(db, "guest", { title: "Added member's post", body: "A public post.", lang: "en", village: "direct-club" });
  expect(topic.ok).toBe(true);
  if (!topic.ok) throw new Error(topic.error);
  expect((await createReply(db, "second", topic.id, { body: "A nonmember can reply.", lang: "en" })).ok).toBe(true);
  vi.stubEnv("VILLAGES", "");
  expect((await listNotifications(db, "guest")).items.map(row => row.kind)).toEqual(["reply_to_topic"]);
  expect(await countUnreadNotifications(db, "guest")).toBe(1);
});

it("requires a current owner of an active invite-public village", async () => {
  const { db, village } = await world();
  expect(await addVillageMember(db, "second", "direct-club", "direct_guest")).toMatchObject({ error: "forbidden" });
  await createVillage(db, "owner", { slug: "open-club", name: "Open", description: "", kind: "open" });
  expect(await addVillageMember(db, "owner", "open-club", "direct_guest")).toMatchObject({ error: "invalid" });
  await db.insert(villages).values({ slug: "closed-club", name: "Closed", kind: "closed" });
  expect(await addVillageMember(db, "owner", "closed-club", "direct_guest")).toMatchObject({ error: "not_found" });
  expect(await addVillageMember(db, "owner", "en", "direct_guest")).toMatchObject({ error: "forbidden" });
  await db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "owner"));
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest")).toMatchObject({ error: "forbidden" });
  await db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, "owner"));
  await endVillage(db, "owner", "direct-club");
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest")).toMatchObject({ error: "not_found" });
  expect(await db.select().from(villageMembers).where(eq(villageMembers.villageId, village.id))).toHaveLength(1);
  vi.stubEnv("VILLAGES", "");
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest")).toMatchObject({ error: "disabled" });
});

it("refuses to remove a co-owner without changing membership, notifications or events, but permits voluntary departure", async () => {
  const { db, village } = await world();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  const before = await db.select().from(villageMembers);
  const events = await db.select().from((await import("~/lib/db/schema")).villageEvents);
  expect(await removeVillageMember(db, "owner", "direct-club", "direct_second", "")).toMatchObject({ error: "forbidden" });
  expect(await db.select().from(villageMembers)).toEqual(before);
  expect(await db.select().from(notifications)).toEqual([]);
  expect(await db.select().from((await import("~/lib/db/schema")).villageEvents)).toEqual(events);
  expect(await changeVillageMembership(db, "second", "direct-club", "leave")).toBe(true);
});

it("selects the adding actor's name by screen language and anonymizes it after departure", async () => {
  const { db, village } = await world();
  await db.update(profiles).set({ displayName: "所有者", displayNameLatin: "Village Owner", homeArea: "ja" }).where(eq(profiles.userId, "owner"));
  await addVillageMember(db, "owner", "direct-club", "direct_guest");
  for (const [locale, name] of [["en", "Village Owner"], ["ja", "所有者"]] as const) {
    setTestLocale(locale);
    expect((await listNotifications(db, "guest")).items[0]).toMatchObject({ actorHandle: "direct_owner", actorName: name });
  }
  await deleteAccount(db, "owner", { confirmation: "direct_owner", villages: { [village.id]: "end" } });
  expect((await listNotifications(db, "guest")).items[0]).toMatchObject({ actorHandle: DELETED_MEMBER_HANDLE, actorName: null });
});

it("keeps voluntary departure across owner and username changes, while allowing an accepted invitation to return", async () => {
  const { db, village } = await world();
  await addVillageMember(db, "owner", "direct-club", "direct_guest");
  expect(await changeVillageMembership(db, "guest", "direct-club", "leave")).toBe(true);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  await db.update(profiles).set({ handle: "renamed_guest", handleKey: "renamed_guest" }).where(eq(profiles.userId, "guest"));
  expect(await addVillageMember(db, "second", "direct-club", "renamed_guest")).toEqual({ ok: false, error: "self_left" });
  expect(await inviteToVillage(db, "second", "direct-club", "renamed_guest", "join")).toMatchObject({ ok: true });
  const [invite] = await db.select().from(villageInvites).where(eq(villageInvites.userId, "guest"));
  expect(await db.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "guest")))).toEqual([]);
  expect(await respondToVillageInvite(db, "guest", "direct-club", invite.id, "accepted")).toMatchObject({ ok: true });
  await removeVillageMember(db, "second", "direct-club", "renamed_guest", "");
  expect(await addVillageMember(db, "owner", "direct-club", "renamed_guest")).toMatchObject({ error: "self_left" });
  expect(await db.select().from(villageDepartures).where(eq(villageDepartures.userId, "guest"))).toHaveLength(1);
  await createVillage(db, "owner", { slug: "another-direct", name: "Another", description: "", kind: "invite_public" });
  expect(await addVillageMember(db, "owner", "another-direct", "renamed_guest")).toMatchObject({ ok: true });
});

it("removes without a reason, keeps posts, permits re-addition and keeps owner promotion subject to consent", async () => {
  const { db, village } = await world();
  await addVillageMember(db, "owner", "direct-club", "direct_guest");
  expect(await inviteToVillage(db, "owner", "direct-club", "direct_guest", "owner")).toMatchObject({ ok: true });
  const [pending] = await db.select().from(villageInvites);
  expect((await db.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "guest"))))[0].role).toBe("member");
  const topic = await createTopic(db, "guest", { body: "Kept public article.", lang: "en", village: "direct-club" });
  if (!topic.ok) throw new Error(topic.error);
  expect(await removeVillageMember(db, "owner", "direct-club", "direct_guest", "x".repeat(VILLAGE_REMOVAL_REASON_MAX + 1))).toMatchObject({ error: "invalid" });
  expect(await removeVillageMember(db, "owner", "direct-club", "direct_guest", null)).toMatchObject({ ok: true });
  expect((await getThread(db, topic.id))?.topic.id).toBe(topic.id);
  expect(await db.select().from(villageDepartures)).toEqual([]);
  expect((await listNotifications(db, "guest")).items.find(row => row.kind === "village_removed")?.village?.reason).toBe("");
  expect(await respondToVillageInvite(db, "guest", "direct-club", pending.id, "accepted")).toMatchObject({ error: "not_found" });
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest")).toMatchObject({ ok: true });
});

it("shares the rolling daily limit with invitations, including removed members", async () => {
  const { db, village } = await world(), now = new Date();
  await db.insert(villageInvites).values(Array.from({ length: VILLAGE_INVITE_DAILY_LIMIT - 1 }, () => ({ villageId: village.id, userId: "second", invitedBy: "owner", kind: "join", state: "cancelled", createdAt: now })));
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest", now)).toMatchObject({ ok: true });
  await removeVillageMember(db, "owner", "direct-club", "direct_guest", "");
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest", now)).toMatchObject({ error: "invite_limit" });
  expect(await inviteToVillage(db, "owner", "direct-club", "direct_second", "join", now)).toMatchObject({ error: "invite_limit" });
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest", new Date(now.getTime() + 86400000))).toMatchObject({ ok: true });
});

it("ignores invitation refusals for direct additions and retires a pending join invitation", async () => {
  const { db, village } = await world(), now = new Date();
  await db.insert(villageInvites).values([0, 1].map(() => ({ villageId: village.id, userId: "guest", invitedBy: "owner", kind: "join", state: "declined", createdAt: now, respondedAt: now })));
  await db.insert(villageInvites).values({ villageId: village.id, userId: "guest", invitedBy: "owner", kind: "join" });
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest")).toMatchObject({ ok: true });
  expect(await db.select().from(villageInvites).where(eq(villageInvites.state, "pending"))).toEqual([]);
  expect(await addVillageMember(db, "owner", "direct-club", "direct_guest")).toMatchObject({ error: "invalid" });
  expect(await db.select().from(notifications).where(eq(notifications.kind, "village_added"))).toHaveLength(1);
});
