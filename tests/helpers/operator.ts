import { loadOperatorConfig } from "~/lib/operator-config.server";
import path from "node:path";
export const testOperator = loadOperatorConfig({ TOMOLA_OPERATOR_DIR: path.resolve("tests/fixtures/operator") });
export const TRIAL_CONSENT_VERSION = testOperator.participation.trialConsentVersion;
export const STANCE_CONSENT_VERSION = testOperator.participation.stanceConsentVersion;
export const EXCLUDED_RESIDENCE_COUNTRIES = testOperator.participation.excludedResidenceCountries;
