import { operatorConfig, operatorDocument } from "~/lib/operator-config.server";
import { googleLoginConfig } from "~/lib/auth/google-config.server";
import { m } from "~/paraglide/messages.js";

export type NoticeKind = "privacy" | "terms";
export type NoticeSources = { ja: string; en: string };

export function noticeSources(kind: NoticeKind): NoticeSources {
  const texts = { ja: operatorDocument(kind, "ja"), en: operatorDocument(kind, "en") };
  if (kind === "privacy" && googleLoginConfig()) {
    for (const locale of ["ja", "en"] as const) {
      const section = Math.max(0, ...[...texts[locale].matchAll(/^## (\d+)\. /gm)].map(match => Number(match[1]))) + 1;
      texts[locale] += `\n\n## ${section}. ${m.google_settings_heading({}, { locale })}\n\n${m.google_privacy({}, { locale })}\n`;
    }
  }
  return texts;
}
// Startup has validated every required edition; publication never disables participation rules.
export function noticesAvailable() { operatorConfig(); return { privacy: true, terms: true }; }
export function trialParticipationRequired(): boolean {
  const policy = operatorConfig().participation;
  return policy.requireTrialConsent || policy.minimumAge > 0 || policy.excludedResidenceCountries.length > 0;
}
