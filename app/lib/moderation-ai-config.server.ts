import { modelMatchesProvider, primaryEngineId } from "./llm/config.server";
import { DEFAULT_GEMINI_MODEL } from "./llm/engines/gemini.server";
import type { LlmEnv } from "./llm/types";

export const spamEnabled = (env: LlmEnv = process.env) => env.MODERATION_SPAM_ENABLED === "1";
export const aiSpamEnabled = (env: LlmEnv = process.env) => spamEnabled(env) && env.MODERATION_AI_SPAM_ENABLED === "1";
export const triageEnabled = (env: LlmEnv = process.env) => env.MODERATION_AI_TRIAGE_ENABLED === "1";

// Shared by the actual completer and the public description; no client or call is created here.
export function moderationAiConfig(env: LlmEnv = process.env) {
  const engine = primaryEngineId(env);
  const model = env.MODERATION_AI_MODEL?.trim() || (engine === "claude" ? "claude-haiku-4-5" : engine === "fake" ? "fake-moderation" : DEFAULT_GEMINI_MODEL);
  if (!modelMatchesProvider(engine, model)) throw new Error("MODERATION_AI_MODEL must match the translation provider");
  return { engine, model };
}
