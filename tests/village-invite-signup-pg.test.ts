import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { invitations, notifications, profiles, user, villageMembers, villages } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken, markInvitationUsed } from "~/lib/invitations.server";
import { createProfile } from "~/lib/profiles.server";
import { createSignupInvitation, rememberSignupInvitation } from "~/lib/signup-village.server";
import { ensureLanguageVillages, languageVillage } from "~/lib/villages.server";
import { addMember } from "./helpers/db";
import { holdTx, waitForLockWait, expectSettlesWithin } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("signup invitations on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, admin: pg.Client, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
    const db = await scratch.open("setup"), sender = `signup_sender_${++seq}`, member = `signup_recipient_${seq}`;
    await addMember(db, sender, sender, { homeArea: "other" });
    await db.insert(user).values({ id: member, name: "", email: `${member}@example.com`, emailVerified: true });
    const [village] = await db.insert(villages).values({ slug: `signup-race-${seq}`, kind: "invite_public", name: "Signup race" }).returning();
    await db.insert(villageMembers).values({ villageId: village.id, userId: sender, role: "owner" });
    const created = await createInvitation(db, { email: `${member}@example.com`, createdBy: sender, villageId: village.id });
    const invitation = (await findValidInvitationByToken(db, created.token))!;
    return { db, sender, member, village, invitation };
  }
  it("consumes an opened invitation only once across connections", async () => {
    const w = await world(), a = await scratch.open("consume-a"), b = await scratch.open("consume-b");
    const results = await expectSettlesWithin(Promise.all([a, b].map((db, index) => markInvitationUsed(db, w.invitation.email, { invitationId: w.invitation.id, usedBy: `winner-${index}` }))), 10000, "single-use invitation");
    expect(results.sort()).toEqual([0, 1]);
    expect((await w.db.select().from(invitations).where(eq(invitations.id, w.invitation.id)))[0].usedBy).toMatch(/^winner-/);
  });
  it("checks the inviter's suspension after waiting for its profile lock, without failing registration", async () => {
    const w = await world();
    await markInvitationUsed(w.db, w.invitation.email, { invitationId: w.invitation.id, usedBy: w.member });
    await rememberSignupInvitation(w.db, w.member, w.invitation.id);
    const held = holdTx(await scratch.open(), async tx => {
      await tx.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, w.sender));
    });
    await held.ready;
    const signup = createProfile(await scratch.open("signup-suspended"), w.member, { handle: w.member, homeArea: "other" });
    try { await waitForLockWait(admin, "signup-suspended"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(signup, 10000, "signup after suspension")).toMatchObject({ ok: true });
    expect(await w.db.select().from(villageMembers).where(eq(villageMembers.userId, w.member))).toEqual([]);
    expect(await w.db.select().from(notifications).where(eq(notifications.userId, w.member))).toEqual([]);
  });
  it.each(["ended", "owner_removed"])("rechecks a %s destination after waiting for the village lock", async state => {
    const w = await world();
    await markInvitationUsed(w.db, w.invitation.email, { invitationId: w.invitation.id, usedBy: w.member });
    await rememberSignupInvitation(w.db, w.member, w.invitation.id);
    const blocker = await scratch.open("signup-blocker"), creating = await scratch.open("signup-creating");
    const held = holdTx(blocker, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update");
      if (state === "ended") await tx.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, w.village.id));
      else await tx.delete(villageMembers).where(and(eq(villageMembers.userId, w.sender), eq(villageMembers.villageId, w.village.id)));
    });
    await held.ready;
    const signup = createProfile(creating, w.member, { handle: w.member, homeArea: "other" });
    try { await waitForLockWait(admin, "signup-creating"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(signup, 10000, "signup after destination change")).toMatchObject({ ok: true });
    expect(await w.db.select().from(profiles).where(eq(profiles.userId, w.member))).toHaveLength(1);
    expect(await w.db.select().from(villageMembers).where(eq(villageMembers.userId, w.member))).toEqual([]);
    expect(await w.db.select().from(notifications).where(eq(notifications.userId, w.member))).toEqual([]);
  });
  it("rejects attachment when the sender loses ownership while creation waits", async () => {
    const w = await world(), blocker = await scratch.open("attachment-blocker"), creating = await scratch.open("attachment-creating");
    const held = holdTx(blocker, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update");
      await tx.delete(villageMembers).where(and(eq(villageMembers.userId, w.sender), eq(villageMembers.villageId, w.village.id)));
    });
    await held.ready;
    const pending = createSignupInvitation(creating, w.sender, "new-recipient@example.com", w.village.id);
    try { await waitForLockWait(admin, "attachment-creating"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(pending, 10000, "invitation after ownership change")).toBeNull();
  });
  it("locks the sender before acquiring language-village foreign-key locks", async () => {
    const w = await world();
    await ensureLanguageVillages(w.db);
    const language = (await languageVillage(w.db, "en"))!;
    await markInvitationUsed(w.db, w.invitation.email, { invitationId: w.invitation.id, usedBy: w.member });
    await rememberSignupInvitation(w.db, w.member, w.invitation.id);
    const blocker = await scratch.open("signup-sender-blocker"), creating = await scratch.open("signup-language-creating"), checking = await scratch.open("signup-language-checking");
    const held = holdTx(blocker, tx => tx.select().from(profiles).where(eq(profiles.userId, w.sender)).for("update"));
    await held.ready;
    const signup = createProfile(creating, w.member, { handle: w.member, homeArea: "en" });
    try {
      await waitForLockWait(admin, "signup-language-creating");
      // An owner leaving their language village needs this lock while holding
      // their own profile. Signup must not already hold its implicit FK lock.
      const lock = checking.transaction(tx => tx.select().from(villages).where(eq(villages.id, language.id)).for("update"));
      await expectSettlesWithin(lock, 5000, "language village while sender is locked");
    } finally { await held.commit(); }
    expect(await expectSettlesWithin(signup, 10000, "signup after sender unlock")).toMatchObject({ ok: true });
    expect(await w.db.select().from(villageMembers).where(and(eq(villageMembers.userId, w.member), eq(villageMembers.villageId, w.village.id)))).toHaveLength(1);
  });
});
