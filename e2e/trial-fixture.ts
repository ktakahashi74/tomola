import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles } from "../app/lib/db/schema";
import { TRIAL_CONSENT_VERSION, STANCE_CONSENT_VERSION } from "./operator-fixture";
export async function acceptTrialFixture(db: Db, userId?: string) {
  const now = new Date();
  await db.update(profiles).set({ residenceCountry: "JP", adultConfirmedAt: now, trialConsentVersion: TRIAL_CONSENT_VERSION, trialConsentAt: now, stanceConsentVersion: STANCE_CONSENT_VERSION, stanceConsentAt: now }).where(userId ? eq(profiles.userId, userId) : undefined);
}
