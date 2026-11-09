import { isDeletedIdentity } from "./deleted-member";
import { trialParticipationRequired } from "~/lib/notice-sources.server";
import { isExcludedCountry, needsTrialConsent } from "~/lib/trial-consent.server";
import type { Db } from "~/lib/db/client.server";
import type { ReportReason } from "~/lib/moderation";
import { getProfile, type Profile } from "~/lib/profiles.server";

// Central membership-access decision shared by three entry points:
//   - Browser screens: requireMember, app/lib/auth/session.server.ts.
//   - Read authentication: authenticateRead for twins, changes, manifest and signed links; app/lib/api/read-auth.server.ts.
//   - Draft API: POST /api/drafts, app/lib/api/drafts-api.server.ts.
// Active membership currently means completed registration with a profile. A bare user still onboarding (area, languages, display name) does not qualify.
//
// Writes (topics/replies, edit/delete, drafts, reactions, stance selection, reports, mistranslation reports, token creation, invites, API drafts, moderation) additionally pass getWriter,
// via requireWriter in app/lib/auth/session.server.ts. Callers exhaustively distinguish each WriterDenied reason
// in switches in requireWriter and drafts-api.server.ts; adding a reason makes typechecking expose missing handling.
//
// Suspension (profiles.suspended_until) still permits login, reading screens/twins, read tokens/signed links and
// appeals, but prevents writes. Do not apply suspension in getActiveMember, so reading entry points remain unaffected;
// only getWriter returns suspended. Do not revoke existing sessions/tokens: suspension expires and reading remains available.
// Writes resume automatically after expiry.
export async function getActiveMember(db: Db, userId: string): Promise<Profile | null> {
  return getProfile(db, userId);
}

export type WriterDenied = "not_a_member" | "suspended" | "trial_consent_required" | "trial_restricted";
export type WriterResult =
  | { ok: true; profile: Profile }
  | { ok: false; reason: "not_a_member" | "trial_consent_required" | "trial_restricted" }
  // until: suspension expiry. category: reason category.
  | { ok: false; reason: "suspended"; profile: Profile; until: Date; category: ReportReason | null };

export async function getWriter(db: Db, userId: string, opts: { now?: Date; profile?: Profile } = {}): Promise<WriterResult> {
  if (isDeletedIdentity(userId)) return { ok: false, reason: "not_a_member" };
  const profile = opts.profile?.userId === userId ? opts.profile : await getActiveMember(db, userId);
  if (!profile) return { ok: false, reason: "not_a_member" };
  if (profile.suspendedUntil !== null && profile.suspendedUntil > (opts.now ?? new Date())) {
    return { ok: false, reason: "suspended", profile, until: profile.suspendedUntil, category: profile.suspendedReason };
  }
  if (trialParticipationRequired()) {
    if (isExcludedCountry(profile.residenceCountry)) return { ok: false, reason: "trial_restricted" };
    if (needsTrialConsent(profile)) return { ok: false, reason: "trial_consent_required" };
  }
  return { ok: true, profile };
}
