import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { entries, notifications, profiles, user, villageEvents, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { createReply, createTopic, deleteOwnEntry, getThread } from "~/lib/entries.server";
import { getViewer } from "~/lib/roles.server";
import { hideEntry } from "~/lib/moderation.server";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { changeVillageMembership, ensureLanguageVillages, listJoinedVillages, listVillages, postingVillages, setDefaultVillage, topicVillage, topicVillageNames, villageBySlug } from "~/lib/villages.server";
import { cancelVillageInvite, createVillage, editVillage, endVillage, incomingVillageInvites, inviteToVillage, removeVillageMember, respondToVillageInvite, villageManagement } from "~/lib/village-management.server";
import { VILLAGE_CREATE_LIMIT, VILLAGE_DESCRIPTION_MAX, VILLAGE_NAME_MAX, VILLAGE_REMOVAL_REASON_MAX } from "~/lib/villages";
import { setVote } from "~/lib/votes.server";
import { setStance } from "~/lib/stances.server";
import { hitMemberLimit } from "~/lib/rate-limit.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const input = { title: "A village topic", body: "An owned topic.", lang: "en" };
async function setup(kind = "invite_public") {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  for (const id of ["owner", "guest", "second"]) await addMember(db, id, `vc_${id}`, { homeArea: "en" });
  expect(await createVillage(db, "owner", { slug: "club", name: "Our village", description: "<b>Plain text</b>", kind })).toEqual({ ok: true, slug: "club" });
  return db;
}
async function invite(db: Awaited<ReturnType<typeof setup>>, target = "guest", kind: "join" | "owner" = "join", slug = "club", inviter = "owner", now = new Date()) {
  expect(await inviteToVillage(db, inviter, slug, `vc_${target}`, kind, now)).toMatchObject({ ok: true });
  const village = (await villageBySlug(db, slug))!;
  const [pending] = await db.select().from(villageInvites).where(and(eq(villageInvites.userId, target), eq(villageInvites.state, "pending"), eq(villageInvites.villageId, village.id), eq(villageInvites.kind, kind)));
  return pending.id;
}
async function accept(db: Awaited<ReturnType<typeof setup>>, target = "guest", kind: "join" | "owner" = "join") {
  const id = await invite(db, target, kind);
  expect(await respondToVillageInvite(db, target, "club", id, "accepted")).toMatchObject({ ok: true });
  return id;
}

describe("member-created villages", () => {
  it("limits creation attempts to five a day even when the lifetime quota has space", async () => {
    const db = await setup();
    const now = new Date();
    for (let i = 0; i < 5; i++) await hitMemberLimit(db, "village-create", "guest", now);
    const input = { slug: "daily-limit", kind: "open", name: "Daily", description: "" };
    expect(await createVillage(db, "guest", input, { now })).toEqual({ ok: false, error: "rate_limited" });
    expect(await villageBySlug(db, input.slug)).toBeNull();
    expect(await createVillage(db, "guest", input, { now: new Date(now.getTime() + 86400_000) })).toMatchObject({ ok: true });
  });
  it("validates lowercase slugs, reserved languages/routes, immutable kinds and text lengths", async () => {
    const db = await setup();
    for (const slug of ["", "EN", "en", "es", "pt", "zh-hans", "login", "villages", "new", "a--b", "-bad", "bad_", "a".repeat(64)])
      expect(await createVillage(db, "owner", { slug, kind: "open", name: "Valid", description: "" })).toEqual({ ok: false, error: "invalid" });
    for (const fields of [{ kind: "closed" }, { name: " " }, { name: "x".repeat(VILLAGE_NAME_MAX + 1) }, { description: "x".repeat(VILLAGE_DESCRIPTION_MAX + 1) }])
      expect(await createVillage(db, "owner", { slug: "valid", kind: "open", name: "Valid", description: "", ...fields })).toEqual({ ok: false, error: "invalid" });
    expect(await createVillage(db, "guest", { slug: "club", name: "Duplicate", kind: "open", description: "" })).toEqual({ ok: false, error: "slug_taken" });
    expect((await villageBySlug(db, "club"))?.kind).toBe("invite_public");
    expect(await villageManagement(db, (await villageBySlug(db, "club"))!.id, "owner")).toMatchObject({ roster: [{ handle: "vc_owner", role: "owner", self: true }] });
  });
  it("counts villages ended in the last 30 days, releases older ones, and excludes owner promotions", async () => {
    const db = await setup();
    for (let n = 1; n < VILLAGE_CREATE_LIMIT; n++) expect(await createVillage(db, "owner", { slug: `owned-${n}`, kind: "open", name: "Owned", description: "" })).toMatchObject({ ok: true });
    const next = { slug: "another", kind: "open", name: "Another", description: "" };
    expect(await createVillage(db, "owner", next)).toEqual({ ok: false, error: "limit" });
    expect(await endVillage(db, "owner", "club")).toMatchObject({ ok: true });
    expect(await createVillage(db, "owner", next)).toEqual({ ok: false, error: "limit" });
    const later = new Date(Date.now() + 31 * 86400_000);
    expect(await createVillage(db, "owner", next, { now: later })).toMatchObject({ ok: true });
    expect(await createVillage(db, "guest", { ...next, slug: "guest-village" })).toMatchObject({ ok: true });
    await changeVillageMembership(db, "owner", "guest-village", "join");
    expect(await inviteToVillage(db, "guest", "guest-village", "vc_owner", "owner")).toMatchObject({ ok: true });
    const [promotion] = await db.select().from(villageInvites).where(eq(villageInvites.userId, "owner"));
    expect(await respondToVillageInvite(db, "owner", "guest-village", promotion.id, "accepted")).toMatchObject({ ok: true });
    expect(await createVillage(db, "owner", { ...next, slug: "over-limit" })).toEqual({ ok: false, error: "limit" });
  });
  it("keeps owner operations server-authorized and refuses unrecorded operator changes", async () => {
    const db = await setup();
    for (const action of [editVillage(db, "guest", "club", { name: "Changed", description: "" }), endVillage(db, "guest", "club"), inviteToVillage(db, "guest", "club", "vc_second", "join"), cancelVillageInvite(db, "guest", "club", "absent"), removeVillageMember(db, "guest", "club", "vc_second", "Reason")])
      expect(await action).toMatchObject({ ok: false, error: "forbidden" });
    expect(await editVillage(db, "owner", "club", { name: "New name", description: "<script>plain</script>" })).toMatchObject({ ok: true });
    vi.stubEnv("OPERATOR_EMAILS", "second@example.com");
    expect(await editVillage(db, "second", "club", { name: "Operator edit", description: "" })).toEqual({ ok: false, error: "forbidden" });
    expect(await endVillage(db, "second", "en")).toEqual({ ok: false, error: "forbidden" });
    expect(await endVillage(db, "second", "club")).toEqual({ ok: false, error: "forbidden" });
    const history = await db.select().from(villageEvents).where(eq(villageEvents.actorId, "second"));
    expect(history).toEqual([]);
    expect(await endVillage(db, "owner", "club")).toMatchObject({ ok: true });
    expect(await editVillage(db, "second", "club", { name: "Ended village correction", description: "Corrected after ending" })).toEqual({ ok: false, error: "forbidden" });
    // Operators can inspect a non-language village without joining.
    expect((await villageManagement(db, (await villageBySlug(db, "club"))!.id, "second")).roster).toMatchObject([{ handle: "vc_owner" }]);
  });
  it("refuses nonmembers and suspended members on creation and owner mutations", async () => {
    const db = await setup();
    await db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "owner"));
    expect(await editVillage(db, "owner", "club", { name: "Denied", description: "" })).toEqual({ ok: false, error: "forbidden" });
    for (const id of ["owner", "absent"]) expect(await createVillage(db, id, { slug: "denied", kind: "open", name: "Denied", description: "" })).toEqual({ ok: false, error: "forbidden" });
  });
  it("permits public reads while forbidding uninvited joins, post-here and topics", async () => {
    const db = await setup();
    expect((await listVillages(db)).map(row => row.slug)).toContain("club");
    expect(await changeVillageMembership(db, "guest", "club", "join")).toBe(false);
    expect(await createTopic(db, "guest", { ...input, village: "club" })).toEqual({ ok: false, error: "village_required" });
    const pending = await invite(db);
    expect(await createTopic(db, "guest", { ...input, village: "club" })).toEqual({ ok: false, error: "village_required" });
    expect(await respondToVillageInvite(db, "guest", "club", pending, "accepted")).toMatchObject({ ok: true });
    const topic = await createTopic(db, "guest", { ...input, village: "club" });
    if (!topic.ok) throw new Error(topic.error);
    expect((await topicVillage(db, topic.id))?.slug).toBe("club");
    expect((await deleteOwnEntry(db, "owner", topic.id)).ok).toBe(false);
    const viewer = await getViewer(db, { id: "owner", email: "owner@example.com" });
    expect((await hideEntry(db, { id: "owner", scope: viewer.scope }, { entryId: topic.id, reason: "other", note: "Owner cannot moderate posts" })).ok).toBe(false);
    expect((await listJoinedVillages(db, "guest")).some(row => row.slug === "club")).toBe(true);
    expect(await setDefaultVillage(db, "guest", "club")).toBe(true);
    const reply = await createReply(db, "second", topic.id, { body: "Outside reply.", lang: "en" });
    expect(reply.ok).toBe(true);
  });
  it("accepts only the intended recipient, rejects repeat acceptance and cancellation", async () => {
    const db = await setup();
    const pending = await invite(db);
    expect(await respondToVillageInvite(db, "second", "club", pending, "accepted")).toMatchObject({ ok: false });
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join")).toEqual({ ok: false, error: "pending" });
    expect(await cancelVillageInvite(db, "owner", "club", pending)).toMatchObject({ ok: true });
    expect(await incomingVillageInvites(db, "guest")).toEqual([]);
    expect(await respondToVillageInvite(db, "guest", "club", pending, "accepted")).toMatchObject({ ok: false });
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join")).toEqual({ ok: false, error: "invite_wait" });
    const again = await invite(db, "guest", "join", "club", "owner", new Date(Date.now() + 86400000));
    expect(again).not.toBe(pending);
    expect(await respondToVillageInvite(db, "guest", "club", again, "accepted")).toMatchObject({ ok: true });
    expect(await respondToVillageInvite(db, "guest", "club", again, "accepted")).toMatchObject({ ok: false });
  });
  it("requires consent for owner promotion and protects the last owner when leaving", async () => {
    const db = await setup("open");
    expect(await changeVillageMembership(db, "owner", "club", "leave")).toBe(false);
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "owner")).toEqual({ ok: false, error: "invalid" });
    await changeVillageMembership(db, "guest", "club", "join");
    const pending = await invite(db, "guest", "owner");
    expect(await editVillage(db, "guest", "club", { name: "Early", description: "" })).toMatchObject({ ok: false });
    expect(await changeVillageMembership(db, "owner", "club", "leave")).toBe(false);
    expect(await respondToVillageInvite(db, "guest", "club", pending, "accepted")).toMatchObject({ ok: true });
    expect(await editVillage(db, "guest", "club", { name: "Consented", description: "" })).toMatchObject({ ok: true });
    expect(await changeVillageMembership(db, "owner", "club", "leave")).toBe(true);
    expect(await changeVillageMembership(db, "guest", "club", "leave")).toBe(false);
  });
  it("rejects a stale owner invitation after its recipient leaves or its inviter loses ownership", async () => {
    const db = await setup("open");
    await changeVillageMembership(db, "guest", "club", "join");
    const pending = await invite(db, "guest", "owner");
    await changeVillageMembership(db, "guest", "club", "leave");
    expect(await respondToVillageInvite(db, "guest", "club", pending, "accepted")).toMatchObject({ ok: false });
    await changeVillageMembership(db, "guest", "club", "join");
    const v = (await villageBySlug(db, "club"))!;
    await db.update(villageMembers).set({ role: "member" }).where(and(eq(villageMembers.villageId, v.id), eq(villageMembers.userId, "owner")));
    expect(await respondToVillageInvite(db, "guest", "club", pending, "accepted")).toMatchObject({ ok: false });
    expect(await incomingVillageInvites(db, "guest")).toEqual([]);
  });
  it("pauses the same inviter across villages after two actual refusals and expires at 30 days", async () => {
    const db = await setup();
    const start = new Date();
    for (let n = 0; n < 2; n++) {
      const at = new Date(start.getTime() + n * 86400000);
      const pending = await invite(db, "guest", "join", "club", "owner", at);
      expect(await respondToVillageInvite(db, "guest", "club", pending, "declined", at)).toMatchObject({ ok: true });
    }
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join", new Date(start.getTime() + 86400000 + 2000))).toEqual({ ok: false, error: "paused" });
    await createVillage(db, "owner", { slug: "another-club", name: "Another", description: "", kind: "invite_public" });
    expect(await inviteToVillage(db, "owner", "another-club", "vc_guest", "join", new Date(start.getTime() + 86400000 + 2000))).toEqual({ ok: false, error: "paused" });
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join", new Date(start.getTime() + 31 * 86400000))).toMatchObject({ ok: true });
    const [pending] = await db.select().from(villageInvites).where(eq(villageInvites.state, "pending"));
    await respondToVillageInvite(db, "guest", "club", pending.id, "accepted", new Date(start.getTime() + 31 * 86400000));
    await changeVillageMembership(db, "guest", "club", "leave");
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join", new Date(start.getTime() + 31 * 86400000 + 1))).toMatchObject({ ok: true });
  });
  it("uses response order rather than creation order when timestamps tie", async () => {
    const db = await setup(), at = new Date();
    for (const slug of ["earlier-invite", "later-refusal"]) await createVillage(db, "owner", { slug, kind: "invite_public", name: "Another", description: "" });
    const earlier = await invite(db, "guest", "join", "earlier-invite");
    const club = await invite(db);
    const last = await invite(db, "guest", "join", "later-refusal");
    await respondToVillageInvite(db, "guest", "club", club, "declined", at);
    await respondToVillageInvite(db, "guest", "earlier-invite", earlier, "accepted", at);
    await respondToVillageInvite(db, "guest", "later-refusal", last, "declined", at);
    // There is one refusal after the latest acceptance, so this is not a pause.
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join", at)).toEqual({ ok: false, error: "invite_wait" });
    expect(await inviteToVillage(db, "owner", "club", "vc_guest", "join", new Date(at.getTime() + 86400000))).toMatchObject({ ok: true });
  });
  it("keeps reasons private to the removed member, preserves posts and revokes posting and pending promotions", async () => {
    const db = await setup();
    await accept(db);
    const pendingOwner = await invite(db, "guest", "owner");
    await setDefaultVillage(db, "guest", "club");
    const topic = await createTopic(db, "guest", { ...input, village: "club" });
    if (!topic.ok) throw new Error(topic.error);
    const saved = await createDraft(db, "guest", { kind: "topic", ...input, village: "club" });
    if (!saved.ok) throw new Error(saved.error);
    expect(await removeVillageMember(db, "owner", "club", "vc_guest", "x".repeat(VILLAGE_REMOVAL_REASON_MAX + 1))).toEqual({ ok: false, error: "invalid" });
    expect(await removeVillageMember(db, "owner", "club", "vc_guest", "A reason for the recipient")).toMatchObject({ ok: true });
    expect(await publishDraft(db, "guest", saved.id)).toEqual({ ok: false, error: "village_required" });
    expect(await respondToVillageInvite(db, "guest", "club", pendingOwner, "accepted")).toMatchObject({ ok: false });
    expect((await getThread(db, topic.id))?.topic.id).toBe(topic.id);
    expect((await topicVillage(db, topic.id))?.slug).toBe("club");
    const notices = await listNotifications(db, "guest");
    expect(notices.items.find(row => row.kind === "village_removed")?.village?.reason).toBe("A reason for the recipient");
    expect((await listNotifications(db, "second")).items.some(row => row.kind === "village_removed")).toBe(false);
    expect((await postingVillages(db, "guest")).selected).toBe("@vc_guest");
    expect((await villageManagement(db, (await villageBySlug(db, "club"))!.id, "guest")).roster).toMatchObject([{ handle: "vc_owner" }]);
  });
  it("refuses removal from an ended village without changing membership or sending a notice", async () => {
    const db = await setup();
    await accept(db);
    const village = (await villageBySlug(db, "club"))!;
    expect(await endVillage(db, "owner", "club")).toMatchObject({ ok: true });
    const snapshot = async () => ({
      members: await db.select().from(villageMembers).where(eq(villageMembers.villageId, village.id)),
      events: await db.select().from(villageEvents).where(eq(villageEvents.villageId, village.id)),
      notices: await db.select().from(notifications).where(eq(notifications.userId, "guest")),
    });
    const before = await snapshot();
    expect(await removeVillageMember(db, "owner", "club", "vc_guest", "")).toEqual({ ok: false, error: "not_found" });
    expect(await snapshot()).toEqual(before);
  });
  it("ends a village without removing posts and allows replies, Insightful and stances", async () => {
    const db = await setup();
    await setDefaultVillage(db, "owner", "club");
    const topic = await createTopic(db, "owner", { ...input, village: "club", asksStance: true });
    if (!topic.ok) throw new Error(topic.error);
    const pending = await invite(db);
    expect(await endVillage(db, "owner", "club")).toMatchObject({ ok: true });
    expect((await villageBySlug(db, "club"))?.endedAt).not.toBeNull();
    expect((await listVillages(db)).some(row => row.slug === "club")).toBe(false);
    expect(await changeVillageMembership(db, "guest", "club", "join")).toBe(false);
    expect(await inviteToVillage(db, "owner", "club", "vc_second", "join")).toMatchObject({ ok: false });
    expect(await respondToVillageInvite(db, "guest", "club", pending, "accepted")).toMatchObject({ ok: false });
    expect(await createTopic(db, "owner", { ...input, village: "club" })).toEqual({ ok: false, error: "village_required" });
    expect((await topicVillage(db, topic.id))?.name).toBe("Our village");
    expect((await topicVillageNames(db, [topic.id])).get(topic.id)?.name).toBe("Our village");
    expect((await postingVillages(db, "owner")).changed).toBe(true);
    expect((await postingVillages(db, "owner")).selected).toBe("@vc_owner");
    expect((await createReply(db, "guest", topic.id, { body: "After ending.", lang: "en" })).ok).toBe(true);
    expect((await setVote(db, "guest", topic.id, true)).ok).toBe(true);
    expect((await setStance(db, "guest", { questionId: topic.id, position: "agree", expectedVersion: 0 })).ok).toBe(true);
    expect(await buildThreadMarkdown(db, topic.id, { lang: "en", k: null, page: 1, sentences: false })).toMatch(/village: ["']?club/);
  });
  it("retains a village when its creator withdraws and preserves management attribution", async () => {
    const db = await setup();
    await db.delete(user).where(eq(user.id, "owner"));
    expect((await villageBySlug(db, "club"))?.createdBy).toBeNull();
    const [event] = await db.select().from(villageEvents);
    expect(event).toMatchObject({ actorId: null, actorHandle: "vc_owner", action: "create" });
  });
  it("omits closed villages, IDs and anonymous counts, and restricts rosters to members", async () => {
    const db = await setup();
    await db.insert(villages).values({ slug: "closed-test", name: "Closed", kind: "closed" });
    const anonymous = await listVillages(db);
    expect(anonymous.every(row => !("id" in row) && !("members" in row) && !("joined" in row))).toBe(true);
    expect(anonymous.some(row => row.slug === "closed-test")).toBe(false);
    expect(await villageBySlug(db, "closed-test")).toBeNull();
    const v = (await villageBySlug(db, "club"))!;
    expect((await villageManagement(db, v.id, "guest")).roster).toMatchObject([{ handle: "vc_owner" }]);
    await invite(db);
    const incoming = await incomingVillageInvites(db, "guest");
    expect(incoming).toMatchObject([{ slug: "club", members: 1, inviter: "vc_owner", villageKind: "invite_public" }]);
    expect(JSON.stringify(incoming)).not.toContain(v.id);
    expect(await incomingVillageInvites(db, "second")).toEqual([]);
  });
  it("does no village reads or writes through the new operations when disabled", async () => {
    const db = await setup();
    await invite(db);
    vi.stubEnv("VILLAGES", "");
    const spy = vi.spyOn(db, "select");
    expect(await createVillage(db, "owner", { slug: "no", kind: "open", name: "No", description: "" })).toEqual({ ok: false, error: "disabled" });
    expect(await editVillage(db, "owner", "club", { name: "No", description: "" })).toMatchObject({ error: "disabled" });
    expect(await endVillage(db, "owner", "club")).toMatchObject({ error: "disabled" });
    expect(await inviteToVillage(db, "owner", "club", "vc_second", "join")).toMatchObject({ error: "disabled" });
    expect(await incomingVillageInvites(db, "guest")).toEqual([]);
    expect(await topicVillageNames(db, [1])).toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await listNotifications(db, "guest")).items).toEqual([]);
    expect(await countUnreadNotifications(db, "guest")).toBe(0);
  });
});
