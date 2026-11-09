import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles } from "~/lib/db/schema";
import { TRIAL_CONSENT_VERSION, STANCE_CONSENT_VERSION } from "./operator";

// Ordinary service fixtures represent members who completed both agreements.
// Consent boundary tests clear the relevant columns explicitly.
export async function acceptTrialFixture(db: Db, userId: string) {
  const now = new Date("2026-09-01T00:00:00Z");
  await db.update(profiles).set({ residenceCountry: "JP", adultConfirmedAt: now, trialConsentVersion: TRIAL_CONSENT_VERSION, trialConsentAt: now, stanceConsentVersion: STANCE_CONSENT_VERSION, stanceConsentAt: now }).where(eq(profiles.userId, userId));
}
export const trialForm = { residenceCountry: "JP", adult: "1", trialAgree: "1", trialVersion: String(TRIAL_CONSENT_VERSION) };
