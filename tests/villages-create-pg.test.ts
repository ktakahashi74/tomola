import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { addMember } from "./helpers/db";
import { entries, notifications, profiles, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { changeVillageMembershipResult, ensureLanguageVillages, postingVillages, restoreEndedDefaultVillage, villageBySlug, villageForTopic, changeVillageMembership } from "~/lib/villages.server";
import { addVillageMember, cancelVillageInvite, createVillage, endVillage, inviteToVillage, respondToVillageInvite } from "~/lib/village-management.server";
import { VILLAGE_INVITE_DAILY_LIMIT } from "~/lib/villages";
import { createTopic } from "~/lib/entries.server";
import type pg from "pg";

describe.skipIf(!REAL_PG_URL)("village mutation concurrency on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, admin: pg.Client, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
    const db = await scratch.open("setup"), owner = `vcp_owner${++seq}`, guest = `vcp_guest${seq}`, slug = `race-${seq}`;
    await ensureLanguageVillages(db);
    await addMember(db, owner, owner, { homeArea: "en" }); await addMember(db, guest, guest, { homeArea: "en" });
    await createVillage(db, owner, { slug, name: "Concurrent village", description: "", kind: "open" });
    await changeVillageMembership(db, guest, slug, "join");
    return { db, owner, guest, slug, village: (await villageBySlug(db, slug))! };
  }
  it("serializes two creations at the last available slot", async () => {
    const w = await world();
    for (let n = 0; n < 3; n++) await createVillage(w.db, w.owner, { slug: `slot-${seq}-${n}`, name: "Slot", description: "", kind: "open" });
    const a = await scratch.open("create-a"), b = await scratch.open("create-b");
    const results = await expectSettlesWithin(Promise.all([a, b].map((db, index) => createVillage(db, w.owner, { slug: `last-${seq}-${index}`, name: "Last slot", description: "", kind: "open" }))), 10000, "concurrent creations");
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "limit" }]);
  });
  it("shares the last daily slot between a direct addition and an owner invitation", async () => {
    const w = await world(), now = new Date(), target = `vcp_direct${seq}`, slug = `direct-cap-${seq}`;
    await addMember(w.db, target, target, { homeArea: "en" });
    await createVillage(w.db, w.owner, { slug, name: "Direct", description: "", kind: "invite_public" });
    await w.db.insert(villageInvites).values(Array.from({ length: VILLAGE_INVITE_DAILY_LIMIT - 1 }, () => ({ villageId: w.village.id, userId: w.guest, invitedBy: w.owner, kind: "owner", state: "cancelled", createdAt: now })));
    const a = await scratch.open("direct-cap-a"), b = await scratch.open("direct-cap-b");
    const results = await expectSettlesWithin(Promise.all([
      addVillageMember(a, w.owner, slug, target, now),
      inviteToVillage(b, w.owner, w.slug, w.guest, "owner", now),
    ]), 10000, "shared addition and invitation quota");
    expect(results.filter(row => row.ok)).toHaveLength(1);
    expect(results.filter(row => !row.ok)).toEqual([{ ok: false, error: "invite_limit" }]);
  });
  it("adds a recipient once when two owners act concurrently", async () => {
    const w = await world(), target = `vcp_once${seq}`, slug = `direct-once-${seq}`;
    await addMember(w.db, target, target, { homeArea: "en" });
    await createVillage(w.db, w.owner, { slug, name: "Direct", description: "", kind: "invite_public" });
    const village = (await villageBySlug(w.db, slug))!;
    await w.db.insert(villageMembers).values({ villageId: village.id, userId: w.guest, role: "owner" });
    const a = await scratch.open("direct-once-a"), b = await scratch.open("direct-once-b");
    const results = await expectSettlesWithin(Promise.all([addVillageMember(a, w.owner, slug, target), addVillageMember(b, w.guest, slug, target)]), 10000, "concurrent additions");
    expect(results.filter(row => row.ok)).toHaveLength(1);
    expect(results.filter(row => !row.ok)).toEqual([{ ok: false, error: "invalid" }]);
    expect(await w.db.select().from(notifications).where(eq(notifications.userId, target))).toHaveLength(1);
  });
  it("observes a voluntary departure before a waiting direct re-addition", async () => {
    const w = await world(), slug = `direct-leave-${seq}`;
    await createVillage(w.db, w.owner, { slug, name: "Direct", description: "", kind: "invite_public" });
    await addVillageMember(w.db, w.owner, slug, w.guest);
    const blocker = await scratch.open("direct-leave-blocker"), leaving = await scratch.open("direct-leaving"), adding = await scratch.open("direct-readding");
    const held = holdTx(blocker, tx => tx.select().from(profiles).where(eq(profiles.userId, w.guest)).for("update"));
    await held.ready;
    const departure = changeVillageMembershipResult(leaving, w.guest, slug, "leave");
    await waitForLockWait(admin, "direct-leaving");
    const addition = addVillageMember(adding, w.owner, slug, w.guest);
    try { await waitForLockWait(admin, "direct-readding"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(departure, 10000, "voluntary departure")).toEqual({ ok: true });
    expect(await expectSettlesWithin(addition, 10000, "addition after departure")).toEqual({ ok: false, error: "self_left" });
  });
  it("retains one owner when two owners leave concurrently", async () => {
    const w = await world();
    await w.db.update(villageMembers).set({ role: "owner" }).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, w.guest)));
    const a = await scratch.open("leave-a"), b = await scratch.open("leave-b");
    const results = await expectSettlesWithin(Promise.all([changeVillageMembershipResult(a, w.owner, w.slug, "leave"), changeVillageMembershipResult(b, w.guest, w.slug, "leave")]), 10000, "concurrent owner departures");
    expect(results.filter(r => r.ok)).toEqual([{ ok: true }]);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "last_owner" }]);
    expect((await w.db.select().from(villageMembers).where(eq(villageMembers.villageId, w.village.id))).filter(r => r.role === "owner")).toHaveLength(1);
  });
  it("cancels an owner's pending invitations before a waiting acceptance after departure", async () => {
    const w = await world(), keeper = `vcp_keeper${seq}`;
    await addMember(w.db, keeper, keeper, { homeArea: "en" });
    await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: keeper, role: "owner" });
    await inviteToVillage(w.db, w.owner, w.slug, w.guest, "owner");
    const [invite] = await w.db.select().from(villageInvites).where(eq(villageInvites.invitedBy, w.owner));
    const blocker = await scratch.open("departure-blocker"), leaving = await scratch.open("departing-owner"), accepting = await scratch.open("accepting-guest");
    const held = holdTx(blocker, tx => tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update"));
    await held.ready;
    const departure = changeVillageMembershipResult(leaving, w.owner, w.slug, "leave");
    await waitForLockWait(admin, "departing-owner");
    const acceptance = respondToVillageInvite(accepting, w.guest, w.slug, invite.id, "accepted");
    try { await waitForLockWait(admin, "accepting-guest"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(departure, 10000, "owner departure")).toEqual({ ok: true });
    expect(await expectSettlesWithin(acceptance, 10000, "acceptance after departure")).toEqual({ ok: false, error: "not_found" });
    expect((await w.db.select().from(villageInvites).where(eq(villageInvites.id, invite.id)))[0].state).toBe("cancelled");
  });
  it("serializes mixed invitation kinds across villages at the last daily slot", async () => {
    const w = await world(), now = new Date(), seed = `vcp_history${seq}`, target = `vcp_target${seq}`, slug = `invited-${seq}`;
    await addMember(w.db, seed, seed, { homeArea: "en" }); await addMember(w.db, target, target, { homeArea: "en" });
    await createVillage(w.db, w.owner, { slug, name: "Invited", description: "", kind: "invite_public" });
    await w.db.insert(villageInvites).values(Array.from({ length: VILLAGE_INVITE_DAILY_LIMIT - 1 }, (_, index) => ({ villageId: w.village.id, userId: seed, invitedBy: w.owner, kind: index % 2 ? "owner" : "join", state: "cancelled", createdAt: now, respondedAt: now })));
    const a = await scratch.open("invite-a"), b = await scratch.open("invite-b");
    const results = await expectSettlesWithin(Promise.all([inviteToVillage(a, w.owner, w.slug, w.guest, "owner", now), inviteToVillage(b, w.owner, slug, target, "join", now)]), 10000, "daily invitation cap");
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "invite_limit" }]);
    expect(await w.db.select().from(villageInvites).where(eq(villageInvites.invitedBy, w.owner))).toHaveLength(VILLAGE_INVITE_DAILY_LIMIT);
  });
  it("rechecks the cancellation cooldown after waiting for a village lock", async () => {
    const w = await world(), now = new Date();
    await inviteToVillage(w.db, w.owner, w.slug, w.guest, "owner", now);
    const [invite] = await w.db.select().from(villageInvites).where(eq(villageInvites.invitedBy, w.owner));
    const blocker = await scratch.open("cancel-blocker"), sender = await scratch.open("cooldown-waiter");
    const held = holdTx(blocker, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update");
      await tx.update(villageInvites).set({ state: "cancelled", respondedAt: now }).where(eq(villageInvites.id, invite.id));
    });
    await held.ready;
    const retry = inviteToVillage(sender, w.owner, w.slug, w.guest, "owner", now);
    try { await waitForLockWait(admin, "cooldown-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(retry, 10000, "reinvite after cancellation")).toEqual({ ok: false, error: "invite_wait" });
    expect(await inviteToVillage(w.db, w.owner, w.slug, w.guest, "owner", new Date(now.getTime() + 86400000))).toMatchObject({ ok: true });
    const [next] = await w.db.select().from(villageInvites).where(and(eq(villageInvites.invitedBy, w.owner), eq(villageInvites.state, "pending")));
    expect(await cancelVillageInvite(w.db, w.owner, w.slug, next.id)).toMatchObject({ ok: true });
  });
  it("blocks a new topic behind ending and rechecks availability after the lock", async () => {
    const w = await world(); const blocker = await scratch.open("ending"), writer = await scratch.open("posting");
    const held = holdTx(blocker, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update");
      await tx.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, w.village.id));
    });
    await held.ready;
    const posting = createTopic(writer, w.guest, { title: "Race topic", body: "Owned race body.", lang: "en", village: w.slug });
    try { await waitForLockWait(admin, "posting"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(posting, 10000, "posting after ending")).toEqual({ ok: false, error: "village_required" });
    expect(await w.db.select().from(entries).where(eq(entries.villageId, w.village.id))).toHaveLength(0);
  });
  it("waits for an in-progress posting permission before ending the village", async () => {
    const w = await world(); const writer = await scratch.open("permission"), ending = await scratch.open("end-waiter");
    const held = holdTx(writer, async tx => { expect(await villageForTopic(tx, w.guest, w.slug)).not.toBeNull(); });
    await held.ready;
    const result = endVillage(ending, w.owner, w.slug);
    try { await waitForLockWait(admin, "end-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(result, 10000, "ending after posting")).toMatchObject({ ok: true });
  });
  it("does not wait on a profile write lock during an ordinary writing-screen read", async () => {
    const w = await world(), blocker = await scratch.open("profile-writer"), reader = await scratch.open("screen-reader");
    const held = holdTx(blocker, tx => tx.select().from(profiles).where(eq(profiles.userId, w.guest)).for("update"));
    await held.ready;
    try { expect((await expectSettlesWithin(postingVillages(reader, w.guest), 2000, "ordinary screen read")).selected).toBe(`@${w.guest}`); }
    finally { await held.rollback(); }
  });
  it("does not overwrite a concurrently chosen default during an ended-default repair", async () => {
    const w = await world(), blocker = await scratch.open("default-writer"), reader = await scratch.open("default-repair");
    await endVillage(w.db, w.owner, w.slug);
    await w.db.update(profiles).set({ defaultVillageId: w.village.id }).where(eq(profiles.userId, w.guest));
    const home = (await villageBySlug(w.db, "en"))!;
    const held = holdTx(blocker, async tx => { await tx.update(profiles).set({ defaultVillageId: home.id }).where(eq(profiles.userId, w.guest)); });
    await held.ready;
    const repair = restoreEndedDefaultVillage(reader, w.guest);
    try { await waitForLockWait(admin, "default-repair"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(repair, 10000, "default repair")).toEqual({ changed: false, defaultVillageId: home.id });
  });
});
