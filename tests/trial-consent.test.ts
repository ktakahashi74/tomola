import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { getProfile } from "~/lib/profiles.server";
import { getWriter } from "~/lib/members.server";
import { saveTrialConsent, setStanceConsent } from "~/lib/trial-consent.server";
import { isCountryCode } from "~/lib/trial-consent";
import { isExcludedCountry } from "~/lib/trial-consent.server";
import { EXCLUDED_RESIDENCE_COUNTRIES, TRIAL_CONSENT_VERSION, STANCE_CONSENT_VERSION } from "./helpers/operator";
import { addMember, createTestDb } from "./helpers/db";

describe("trial participation and separate stance consent", () => {
  it("rejects exactly the excluded countries and accepts ISO country codes only", () => {
    for (const code of EXCLUDED_RESIDENCE_COUNTRIES) expect(isExcludedCountry(code)).toBe(true);
    for (const code of ["JP", "KR", "US", "TW", "HK", "MO"]) expect(isCountryCode(code)).toBe(true);
    for (const code of ["", "XX", "EU", "jp", "JPN"]) expect(isCountryCode(code)).toBe(false);
  });
  it("requires adult and versioned consent, and never records a rejected registration", async () => {
    const db = await createTestDb();
    await addMember(db, "trial", "trial");
    await db.update(profiles).set({ residenceCountry: null, adultConfirmedAt: null, trialConsentAt: null, trialConsentVersion: null }).where(eq(profiles.userId, "trial"));
    expect(await getWriter(db, "trial")).toMatchObject({ ok: false, reason: "trial_consent_required" });
    expect(await saveTrialConsent(db, "trial", { residenceCountry: "JP", adult: false, agree: true, version: TRIAL_CONSENT_VERSION })).toMatchObject({ ok: false, error: "adult_required" });
    expect(await saveTrialConsent(db, "trial", { residenceCountry: "JP", adult: true, agree: true, version: TRIAL_CONSENT_VERSION - 1 })).toMatchObject({ ok: false, error: "trial_consent_required" });
    const now = new Date("2026-10-17T12:00:00Z");
    expect(await saveTrialConsent(db, "trial", { residenceCountry: "JP", adult: true, agree: true, version: TRIAL_CONSENT_VERSION }, { now })).toEqual({ ok: true });
    expect(await getProfile(db, "trial")).toMatchObject({ residenceCountry: "JP", adultConfirmedAt: now, trialConsentVersion: TRIAL_CONSENT_VERSION, trialConsentAt: now });
    expect(await getWriter(db, "trial")).toMatchObject({ ok: true });
    await db.update(profiles).set({ trialConsentVersion: TRIAL_CONSENT_VERSION - 1 }).where(eq(profiles.userId, "trial"));
    expect(await getWriter(db, "trial")).toMatchObject({ ok: false, reason: "trial_consent_required" });
  });
  it("records an existing member's excluded country and prevents writes without erasing records", async () => {
    const db = await createTestDb();
    await addMember(db, "restricted", "restricted");
    expect(await saveTrialConsent(db, "restricted", { residenceCountry: "CN", adult: false, agree: false, version: TRIAL_CONSENT_VERSION })).toMatchObject({ ok: false, error: "country_excluded" });
    expect(await getProfile(db, "restricted")).toMatchObject({ residenceCountry: "CN" });
    expect(await getWriter(db, "restricted")).toMatchObject({ ok: false, reason: "trial_restricted" });
  });
  it("records and revokes stance consent without removing existing stance history", async () => {
    const db = await createTestDb();
    await addMember(db, "stance", "stance");
    expect(await setStanceConsent(db, "stance", true, STANCE_CONSENT_VERSION)).toEqual({ ok: true });
    expect(await getProfile(db, "stance")).toMatchObject({ stanceConsentVersion: STANCE_CONSENT_VERSION, stanceConsentAt: expect.any(Date) });
    expect(await setStanceConsent(db, "stance", false, STANCE_CONSENT_VERSION)).toEqual({ ok: true });
    expect(await getProfile(db, "stance")).toMatchObject({ stanceConsentVersion: null, stanceConsentAt: null });
  });
});
