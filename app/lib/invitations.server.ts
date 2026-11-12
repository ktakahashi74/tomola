import { isDeletedIdentity } from "./deleted-member";
import { isSuspendedDeletedAddress } from "./suspended-email.server";
import { RETENTION, daysBefore } from "~/lib/retention";
import { drainRetentionRows, type RetentionResults } from "~/lib/retention-batch.server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { invitations, profiles, user } from "~/lib/db/schema";
import { invitationNoteText } from "./invitation-note";
import { detectLang } from "./lang-detect.core.server";
import { memberVillageLang } from "./village-translations.server";
import { isLang } from "./languages";

export type Invitation = typeof invitations.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a new invitation link works, in days.
export const INVITATION_TTL_DAYS = 14;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Store only invitation-token hashes: hexadecimal SHA-256 of UTF-8 token text. Return plaintext only once at creation.
// Migration 0023 hashes existing plaintext rows with the same expression.
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createInvitation(
  db: Db,
  input: { email: string; createdBy?: string | null; villageId?: string | null; note?: string; ttlDays?: number; now?: Date },
): Promise<{ token: string; email: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  if (isDeletedIdentity(input.createdBy, email)) throw new Error("Address is not eligible for invitation");
  const note = invitationNoteText(input.note ?? "");
  if (note === null) throw new Error("Invalid invitation note");
  const [author] = note && input.createdBy ? await db.select().from(profiles).where(eq(profiles.userId, input.createdBy)) : [];
  const noteLang = note ? detectLang(note, author?.homeArea) ?? (isLang(author?.homeArea) ? author.homeArea : memberVillageLang(author ?? { homeArea: "other", uiLocale: null, displayLang: null, readLangs: [] })) : null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + (input.ttlDays ?? INVITATION_TTL_DAYS) * DAY_MS);
  await db.insert(invitations).values({
    id: randomUUID(),
    email,
    tokenHash: hashInvitationToken(token),
    createdBy: input.createdBy ?? null,
    villageId: input.villageId ?? null,
    note: note || null,
    noteLang,
    createdAt: now,
    expiresAt,
  });
  return { token, email, expiresAt };
}

// The username of the member who made an invitation, for the invitation page. Null when it has no sender or the sender has no profile any more.
export async function invitationSenderHandle(db: Db, invitation: Pick<Invitation, "createdBy">): Promise<string | null> {
  if (!invitation.createdBy) return null;
  const [row] = await db.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, invitation.createdBy)).limit(1);
  return row?.handle ?? null;
}

export async function findValidInvitationByToken(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<(Invitation & { email: string }) | null> {
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, hashInvitationToken(token)), isNull(invitations.usedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  return row?.email && !isDeletedIdentity(undefined, row.email) ? { ...row, email: row.email } : null;
}

// Atomically consume exactly one valid invitation for the recipient, setting used_at and used_by for the new user. Return the affected count, 0 or 1.
// A single UPDATE selects and marks the invitation used. The outer WHERE also checks used_at IS NULL, so the second concurrent attempt
// waits for the first write, rechecks the condition, and affects zero rows. Concurrent registration cannot create two users from one invitation.
// Prefer the signed entry's invitation when it is valid for this recipient;
// otherwise retain the newest-valid-invitation fallback. Consume at most one.
// On zero rows, the caller's user-creation hook fails.
export async function markInvitationUsed(
  db: Db,
  email: string,
  opts: { usedBy?: string | null; invitationId?: string | null; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const address = normalizeEmail(email);
  if (isDeletedIdentity(opts.usedBy, address) || await isSuspendedDeletedAddress(db, address, now)) return 0;
  if (opts.invitationId) {
    const selected = await db.update(invitations).set({ usedAt: now, usedBy: opts.usedBy ?? null }).where(and(
      eq(invitations.id, opts.invitationId), eq(invitations.email, address),
      isNull(invitations.usedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now),
    )).returning({ id: invitations.id });
    if (selected.length) return selected.length;
  }
  const rows = await db
    .update(invitations)
    .set({ usedAt: now, usedBy: opts.usedBy ?? null })
    .where(
      and(
        isNull(invitations.usedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
        eq(
          invitations.id,
          sql`(select i.id from ${invitations} as i where i.email = ${address} and i.used_at is null and i.revoked_at is null and i.expires_at > ${now} order by i.created_at desc, i.id limit 1)`,
        ),
      ),
    )
    .returning({ id: invitations.id });
  return rows.length;
}

export type InvitationStatus = "valid" | "used" | "expired" | "revoked";

export type InvitationRow = {
  id: string;
  email: string | null;
  // Inviter's handle. Null for operator-created CLI invitations (pnpm invite) and absent users.
  inviterHandle: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: InvitationStatus;
  usedAt: Date | null;
  // Created user's handle. Null if the user exists but has not completed handle registration; usedByExists is then true.
  usedByHandle: string | null;
  // Whether used_by's user exists, distinguishing consumed invitations whose user creation failed partway.
  usedByExists: boolean;
};

// Operator invitation list, newest first. Invitation URLs/tokens cannot be shown because they are not stored.
export async function listInvitations(db: Db, opts: { limit?: number; now?: Date; createdBy?: string } = {}): Promise<InvitationRow[]> {
  const now = opts.now ?? new Date();
  const inviter = alias(profiles, "inviter");
  const usedByProfile = alias(profiles, "used_by_profile");
  const usedByUser = alias(user, "used_by_user");
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      inviterHandle: inviter.handle,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
      usedAt: invitations.usedAt,
      revokedAt: invitations.revokedAt,
      usedByHandle: usedByProfile.handle,
      usedByUserId: usedByUser.id,
    })
    .from(invitations)
    .leftJoin(inviter, eq(inviter.userId, invitations.createdBy))
    .leftJoin(usedByProfile, eq(usedByProfile.userId, invitations.usedBy))
    .leftJoin(usedByUser, eq(usedByUser.id, invitations.usedBy))
    .where(opts.createdBy === undefined ? undefined : eq(invitations.createdBy, opts.createdBy))
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    inviterHandle: r.inviterHandle,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    status: r.usedAt ? "used" : r.revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "valid",
    usedAt: r.usedAt,
    usedByHandle: r.usedByHandle,
    usedByExists: r.usedByUserId !== null,
  }));
}

export async function revokeInvitation(db: Db, actorId: string, id: string, opts: { operator?: boolean; now?: Date } = {}): Promise<boolean> {
  const rows = await db.update(invitations).set({ revokedAt: opts.now ?? new Date() })
    .where(and(eq(invitations.id, id), opts.operator ? undefined : eq(invitations.createdBy, actorId), isNull(invitations.usedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id });
  return rows.length > 0;
}

export async function pruneExpiredInvitationRecipients(db: Db, now = new Date(), results?: RetentionResults): Promise<void> {
  await drainRetentionRows(db, "invitation_recipients", invitations,
    and(isNull(invitations.usedAt), sql`${invitations.email} is not null`, lte(invitations.expiresAt, daysBefore(now, RETENTION.expiredInvitationDays)))!, results, sql`email = null`);
}
