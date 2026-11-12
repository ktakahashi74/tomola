import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { invitations, profiles, user, villages } from "./db/schema";
import { isDeletedIdentity } from "./deleted-member";
import { parseEmail } from "./email";
import { createSignupInvitation } from "./signup-village.server";
import { normalizeEmail, revokeInvitation } from "./invitations.server";
import { isSuspendedDeletedAddress } from "./suspended-email.server";
import { hitRateLimit, MEMBER_RATE_LIMITS, type RateLimitResult } from "./rate-limit.server";
import { inviteUrl } from "./site-url";
import { sendMail } from "./mail/mail.server";
import { signupInvitationMail } from "./mail/signup-invitation.server";
import type { Locale } from "~/paraglide/runtime.js";

export const OPERATOR_INVITATION_BATCH_MAX = 20;
export function parseInvitationEmails(values: readonly string[]): string[] {
  return [...new Set(values.flatMap(value => value.split(/[\s,;]+/u)).filter(Boolean).map(normalizeEmail))];
}

export type OperatorInvitationStatus = "sent" | "created" | "member" | "existing" | "ineligible" | "invalid" | "self" | "send_failed";
export type OperatorInvitationResult = { email: string; status: OperatorInvitationStatus; url?: string };
type BatchError = "too_many" | "invalid_village" | "rate_limited";
type BatchOutcome = { error: null; results: OperatorInvitationResult[] } | { error: BatchError; rate?: RateLimitResult };
class BatchRejected extends Error {
  constructor(readonly reason: BatchError, readonly rate?: RateLimitResult) { super(reason); }
}

// Classification, allowance and creation commit together. The profile lock also
// follows the profile -> village order used by signup and ownership changes.
export async function createOperatorInvitations(db: Db, actor: { id: string; email: string }, input: {
  emails: string[]; villageId: string | null; note: string; sendEmail: boolean; locale: Locale;
}): Promise<BatchOutcome> {
  if (input.emails.length > OPERATOR_INVITATION_BATCH_MAX) return { error: "too_many" as const };
  const now = new Date();
  let batch;
  try {
    batch = await db.transaction(async tx => {
      const [sender] = await tx.select().from(profiles).where(eq(profiles.userId, actor.id)).for("update");
      if (!sender) throw new Error("Invitation sender is unavailable");
      const results: OperatorInvitationResult[] = [];
      const eligible: string[] = [];
      for (const email of input.emails) {
        let status: OperatorInvitationStatus | null = null;
        if (email === normalizeEmail(actor.email)) status = "self";
        else if (isDeletedIdentity(undefined, email) || await isSuspendedDeletedAddress(tx, email, now)) status = "ineligible";
        else if (!parseEmail(email)) status = "invalid";
        else {
          const [member] = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1);
          if (member) status = "member";
          else {
            const [existing] = await tx.select({ id: invitations.id }).from(invitations).where(and(
              eq(invitations.email, email), isNull(invitations.usedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now),
            )).limit(1);
            if (existing) status = "existing";
          }
        }
        if (status) results.push({ email, status });
        else eligible.push(email);
      }
      if (eligible.length) {
        const rate = await hitRateLimit(tx, { key: `member:invitation:${actor.id}`, ...MEMBER_RATE_LIMITS.invitation, cost: eligible.length, now });
        // Roll back a refused reservation; rejected addresses never consume slots.
        if (!rate.allowed) throw new BatchRejected("rate_limited", { ...rate, count: rate.count - eligible.length,
          remaining: Math.max(0, rate.limit - (rate.count - eligible.length)) });
      }
      const created = [];
      for (const email of eligible) {
        const invitation = await createSignupInvitation(tx, actor.id, email, input.villageId, input.note);
        if (!invitation) throw new BatchRejected("invalid_village");
        created.push(invitation);
      }
      const [village] = input.villageId ? await tx.select({ name: villages.name }).from(villages).where(eq(villages.id, input.villageId)) : [];
      return { results, created, sender, villageName: village?.name ?? null };
    });
  } catch (error) {
    if (error instanceof BatchRejected) return { error: error.reason, rate: error.rate };
    throw error;
  }
  for (const invitation of batch.created) {
    const url = inviteUrl(invitation.token);
    if (!input.sendEmail) batch.results.push({ email: invitation.email, status: "created", url });
    else {
      try {
        await sendMail(signupInvitationMail({ to: invitation.email, url, locale: input.locale, sender: batch.sender,
          note: input.note, village: batch.villageName }));
        batch.results.push({ email: invitation.email, status: "sent" });
      } catch {
        await revokeInvitation(db, actor.id, invitation.id);
        batch.results.push({ email: invitation.email, status: "send_failed" });
      }
    }
  }
  return { error: null, results: input.emails.map(email => batch.results.find(result => result.email === email)!) };
}
