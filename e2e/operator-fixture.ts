import fs from "node:fs";
import path from "node:path";
import type { PublicOperatorSettings } from "../app/lib/operator-settings";
import type { AiUseSettings } from "../app/lib/operator-config.server";
import { countryOptions } from "../app/lib/trial-consent";
export const testOperator = JSON.parse(fs.readFileSync(path.join(process.env.TOMOLA_OPERATOR_DIR || path.resolve("tests/fixtures/operator"), "operator.json"), "utf8")) as PublicOperatorSettings & { aiUse: AiUseSettings };
export const TRIAL_CONSENT_VERSION = testOperator.participation.trialConsentVersion;
export const STANCE_CONSENT_VERSION = testOperator.participation.stanceConsentVersion;
// A residence country that these settings exclude from participation.
export const EXCLUDED_COUNTRY = testOperator.participation.excludedResidenceCountries[0];
export const ELIGIBLE_COUNTRY = countryOptions("en").find(country => !testOperator.participation.excludedResidenceCountries.includes(country.code))!.code;
