import type { SeedMember } from "./member-fixtures";

export const EARLY_MEMBERS: readonly SeedMember[] = ["source", "settings", "reports", "parent", "navigation", "focus", "unsupported", "audit", "actor", "reviewer", "onboarding"].map<SeedMember>(name => ({
  email: `early_${name}@example.com`, handle: `early_${name}`, homeArea: "en", readLangs: ["en", "ja"], uiLocale: "en",
}));
