import type { ParticipationSettings } from "./operator-settings";

const COUNTRY_CODES = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");
export function isCountryCode(value: unknown): value is string { return typeof value === "string" && COUNTRY_CODES.includes(value); }
export function isExcludedCountry(country: string | null | undefined, policy: ParticipationSettings): boolean { return country != null && policy.excludedResidenceCountries.includes(country); }

export type TrialProfile = { residenceCountry?: string | null; adultConfirmedAt?: Date | null; trialConsentVersion?: number | null; trialConsentAt?: Date | null };
export function needsTrialConsent(profile: TrialProfile, policy: ParticipationSettings): boolean {
  if (isExcludedCountry(profile.residenceCountry, policy)) return false;
  return !isCountryCode(profile.residenceCountry) || (policy.minimumAge > 0 && !profile.adultConfirmedAt) || profile.trialConsentVersion !== policy.trialConsentVersion || !profile.trialConsentAt;
}
export function hasStanceConsent(profile: { stanceConsentVersion?: number | null; stanceConsentAt?: Date | null }, policy: ParticipationSettings): boolean {
  return profile.stanceConsentVersion === policy.stanceConsentVersion && !!profile.stanceConsentAt;
}

// Called only by loaders. The browser uses these exact labels, including during hydration.
export function countryOptions(locale: string): Array<{ code: string; label: string }> {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return COUNTRY_CODES.map(code => ({ code, label: names.of(code) ?? code })).sort((a, b) => a.label.localeCompare(b.label, locale));
}
export type TrialInput = { residenceCountry: string; adult: boolean; agree: boolean; version: number };
export type TrialError = "invalid_country" | "country_excluded" | "adult_required" | "trial_consent_required";
export function validateTrialInput(input: TrialInput, policy: ParticipationSettings): TrialError | null {
  if (!isCountryCode(input.residenceCountry)) return "invalid_country";
  if (isExcludedCountry(input.residenceCountry, policy)) return "country_excluded";
  if (policy.minimumAge > 0 && !input.adult) return "adult_required";
  if (input.version !== policy.trialConsentVersion || (policy.requireTrialConsent && !input.agree)) return "trial_consent_required";
  return null;
}
