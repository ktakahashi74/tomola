// Show trial navigation only in an explicitly isolated, keyless fake-engine environment.
export function homeTrialEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.TOMOLA_HOME_TRIAL?.trim() !== "1") return false;
  if (env.TOMOLA_ALLOW_FAKE_ENGINES !== "1" || env.TRANSLATION_PRIMARY !== "fake" || env.EMBEDDING_ENGINE !== "fake" || env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY) {
    throw new Error("TOMOLA_HOME_TRIAL requires explicit fake engines and no real model keys");
  }
  return true;
}
