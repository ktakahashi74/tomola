export type ParticipationCopy = {
  countryExcluded: string;
  invitationRestriction: string;
  eligibilitySummary: string;
};

export type ParticipationSettings = {
  minimumAge: number;
  excludedResidenceCountries: readonly string[];
  requireTrialConsent: boolean;
  trialConsentVersion: number;
  stanceConsentVersion: number;
  copy: Record<string, ParticipationCopy>;
};

export type PublicOperatorSettings = {
  name: Record<string, string>;
  contactEmail: string;
  privacyEmail: string;
  participation: ParticipationSettings;
  copy: Record<string, OperatorCopy>;
};

export type OperatorCopy = {
  aiRecipient: string;
  stanceDisclosure: string;
  stanceConsent: string;
  trainingPolicy: string;
  chatProvider: string;
  chatProviderChange: string;
  termsLabel: string | null;
  countryHelp: string | null;
  adultError: string | null;
  agreementLabel: string | null;
  agreementError: string | null;
  reviewTitle: string | null;
  reviewHelp: string | null;
  testSiteNotice: string | null;
};

export function operatorCopy(settings: PublicOperatorSettings, locale: string): OperatorCopy {
  return settings.copy[locale] ?? settings.copy.en;
}

export function formatOperatorCopy(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function operatorName(settings: PublicOperatorSettings, locale: string): string {
  return settings.name[locale] ?? settings.name.en;
}

export function participationCopy(settings: ParticipationSettings, locale: string): ParticipationCopy {
  return settings.copy[locale] ?? settings.copy.en;
}
