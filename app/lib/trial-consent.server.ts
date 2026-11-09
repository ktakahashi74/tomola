import { trialParticipationRequired } from "~/lib/notice-sources.server";
import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles } from "~/lib/db/schema";
import * as consent from "~/lib/trial-consent";
import type { TrialInput, TrialProfile } from "~/lib/trial-consent";
import { operatorConfig } from "~/lib/operator-config.server";

export const trialPolicy = () => operatorConfig().participation;
export const isExcludedCountry = (country: string | null | undefined) => consent.isExcludedCountry(country, trialPolicy());
export const needsTrialConsent = (profile: TrialProfile) => consent.needsTrialConsent(profile, trialPolicy());
export const hasStanceConsent = (profile: Parameters<typeof consent.hasStanceConsent>[0]) => consent.hasStanceConsent(profile, trialPolicy());
export const validateTrialInput = (input: TrialInput) => consent.validateTrialInput(input, trialPolicy());

export function trialConsentValues(input: TrialInput, now = new Date()) {
  return { residenceCountry: input.residenceCountry, adultConfirmedAt: trialPolicy().minimumAge > 0 ? now : null, trialConsentVersion: trialPolicy().trialConsentVersion, trialConsentAt: now };
}
export async function saveTrialConsent(db: Db, userId: string, input: TrialInput, opts: { now?: Date } = {}) {
  if (!trialParticipationRequired()) return { ok: false as const, error: "unavailable" as const };
  const error = validateTrialInput(input);
  // Existing members may still read, but this declaration must immediately stop writes.
  if (error === "country_excluded") await db.update(profiles).set({ residenceCountry: input.residenceCountry }).where(eq(profiles.userId, userId));
  if (error) return { ok: false as const, error };
  const rows = await db.update(profiles).set(trialConsentValues(input, opts.now)).where(eq(profiles.userId, userId)).returning({ id: profiles.userId });
  return rows.length ? { ok: true as const } : { ok: false as const, error: "not_found" as const };
}
export async function setStanceConsent(db: Db, userId: string, agree: boolean, version: number) {
  if (agree && version !== trialPolicy().stanceConsentVersion) return { ok: false as const, error: "consent_changed" as const };
  return db.transaction(async tx => {
    // Same lock as stance selection: a withdrawal of consent cannot race with a new choice.
    const [profile] = await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!profile) return { ok: false as const, error: "not_found" as const };
    await tx.update(profiles).set({ stanceConsentVersion: agree ? trialPolicy().stanceConsentVersion : null, stanceConsentAt: agree ? new Date() : null }).where(eq(profiles.userId, userId));
    return { ok: true as const };
  });
}
