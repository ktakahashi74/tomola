import { operatorConfig, operatorDocument } from "~/lib/operator-config.server";

export type NoticeKind = "privacy" | "terms";
export type NoticeSources = { ja: string; en: string };

export function noticeSources(kind: NoticeKind): NoticeSources {
  return { ja: operatorDocument(kind, "ja"), en: operatorDocument(kind, "en") };
}
// Startup has validated every required edition; publication never disables participation rules.
export function noticesAvailable() { operatorConfig(); return { privacy: true, terms: true }; }
export function trialParticipationRequired(): boolean {
  const policy = operatorConfig().participation;
  return policy.requireTrialConsent || policy.minimumAge > 0 || policy.excludedResidenceCountries.length > 0;
}
