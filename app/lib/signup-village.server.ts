import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { invitations, notifications, profiles, verification, villageDepartures, villageMembers, villages } from "~/lib/db/schema";
import { createInvitation, INVITATION_TTL_DAYS, type Invitation } from "~/lib/invitations.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { getWriter } from "~/lib/members.server";

// The public-kind condition is an allowlist. Future kinds must be explicitly
// admitted here; language villages are never an invitation destination.
const eligible = () => and(inArray(villages.kind, ["open", "invite_public"]), isNotNull(villages.slug), isNull(villages.endedAt), isNull(villages.language), eq(villages.system, false));
const owner = (userId: string) => and(eq(villageMembers.userId, userId), eq(villageMembers.role, "owner"));

export async function signupVillageChoices(db: Db, userId: string) {
  if (!villagesEnabled()) return [];
  return db.select({ id: villages.id, name: villages.name }).from(villages)
    .innerJoin(villageMembers, eq(villageMembers.villageId, villages.id))
    .where(and(eligible(), owner(userId))).orderBy(asc(villages.name), asc(villages.id));
}

export async function createSignupInvitation(db: Db, userId: string, email: string, villageId: string | null, note = "") {
  return db.transaction(async tx => {
    if (villageId) {
      if (!villagesEnabled()) return null;
      // Match the profile -> village order used by ownership changes and ending.
      await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
      const [village] = await tx.select({ id: villages.id }).from(villages).where(and(eq(villages.id, villageId), eligible())).for("update");
      if (!village) return null;
      const [membership] = await tx.select({ id: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, villageId), owner(userId)));
      if (!membership) return null;
    }
    return createInvitation(tx, { email, createdBy: userId, villageId, note });
  });
}

async function signupInvitationDestination(db: Db, invitation: Pick<Invitation, "villageId" | "createdBy">) {
  if (!villagesEnabled() || !invitation.villageId || !invitation.createdBy) return { village: null, denied: null };
  const writer = await getWriter(db, invitation.createdBy);
  if (!writer.ok) return { village: null, denied: writer.reason };
  const [village] = await db.select({ id: villages.id, slug: villages.slug, name: villages.name }).from(villages)
    .innerJoin(villageMembers, eq(villageMembers.villageId, villages.id))
    .where(and(eq(villages.id, invitation.villageId), eligible(), owner(invitation.createdBy)));
  return { village: village ?? null, denied: null };
}

export async function invitationVillage(db: Db, invitation: Pick<Invitation, "villageId" | "createdBy">) {
  return (await signupInvitationDestination(db, invitation)).village;
}

export const signupInvitationIdentifier = (userId: string) => `signup-invitation:${createHash("sha256").update(userId).digest("hex")}`;

// Preserve the verified association after authentication, so profile completion
// does not depend on the browser still carrying its short-lived entry cookie.
export async function rememberSignupInvitation(db: Db, userId: string, invitationId: string | null) {
  if (!invitationId) return;
  const [consumed] = await db.select({ id: invitations.id, villageId: invitations.villageId }).from(invitations).where(and(
    eq(invitations.id, invitationId), eq(invitations.usedBy, userId), isNotNull(invitations.usedAt),
  ));
  if (!consumed?.villageId) return;
  await db.insert(verification).values({ id: randomUUID(), identifier: signupInvitationIdentifier(userId), value: invitationId, expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86400000) });
}

async function consumedInvitation(db: Db, userId: string) {
  if (!villagesEnabled()) return null;
  const [invitation] = await db.select().from(invitations).where(and(
    eq(invitations.usedBy, userId), isNotNull(invitations.usedAt),
    eq(invitations.id, db.select({ id: verification.value }).from(verification).where(and(eq(verification.identifier, signupInvitationIdentifier(userId)), gt(verification.expiresAt, new Date()))).limit(1)),
  ));
  return invitation ?? null;
}

export async function consumedInvitationVillage(db: Db, userId: string) {
  const invitation = await consumedInvitation(db, userId);
  return invitation ? invitationVillage(db, invitation) : null;
}

export async function joinedSignupVillage(db: Db, userId: string) {
  const village = await consumedInvitationVillage(db, userId);
  if (!village) return null;
  const [member] = await db.select({ id: villageMembers.userId }).from(villageMembers)
    .where(and(eq(villageMembers.userId, userId), eq(villageMembers.villageId, village.id)));
  return member ? village : null;
}

// Acquire existing profile locks before even the implicit village FK locks
// taken by automatic language enrollment. Ownership mutations use this order.
export async function lockSignupInvitationOwner(db: Db, userId: string) {
  const invitation = await consumedInvitation(db, userId);
  if (!invitation?.createdBy || !invitation.villageId) return null;
  await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, invitation.createdBy)).for("update");
  return invitation;
}

// Called only inside the transaction inserting this member's first profile,
// after lockSignupInvitationOwner and the normal language enrollment.
export async function enrollFromSignupInvitation(db: Db, userId: string, invitation: Invitation | null) {
  if (!invitation?.createdBy || !invitation.villageId) return null;
  await db.select({ id: villages.id }).from(villages).where(eq(villages.id, invitation.villageId)).for("update");
  const { village, denied } = await signupInvitationDestination(db, invitation);
  if (denied) console.warn("[signup-village] Enrollment skipped", { invitationId: invitation.id, reason: denied });
  if (!village) return null;
  const [departure] = await db.select({ id: villageDepartures.userId }).from(villageDepartures)
    .where(and(eq(villageDepartures.userId, userId), eq(villageDepartures.villageId, village.id)));
  if (departure) return null;
  const inserted = await db.insert(villageMembers).values({ userId, villageId: village.id }).onConflictDoNothing().returning();
  if (inserted.length) {
    const [notice] = await db.insert(notifications).values({ userId, actorId: invitation.createdBy, villageId: village.id, kind: "village_added" })
      .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
    // Keep profile creation out of notification rendering's import cycle.
    const { enqueueImmediateEmails } = await import("~/lib/notifications.server");
    await enqueueImmediateEmails(db, [{ ...notice, kind: "village_added" }]);
  }
  // Do not use enrollInVillage: signup's normal default and chat consent stay intact.
  return village;
}
