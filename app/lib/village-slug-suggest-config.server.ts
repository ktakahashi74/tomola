import type { CompleteRequest, Completion } from "./llm/completion.server";
import { primaryEngineId, modelMatchesProvider, type EngineDeps } from "./llm/config.server";
import { claudeComplete, createClaudeClient, DEFAULT_CLAUDE_MODEL } from "./llm/engines/claude.server";
import { createGeminiClient, geminiComplete, DEFAULT_GEMINI_MODEL, GEMINI_MAX_OUTPUT_TOKENS } from "./llm/engines/gemini.server";
import { thinkingHeadroom } from "./llm/thinking";
import type { LlmEnv } from "./llm/types";
import { villagesEnabled } from "./villages-enabled.server";

export const villageSlugSuggestEnabled = (env: LlmEnv = process.env) => villagesEnabled(env) && env.VILLAGE_SLUG_SUGGEST === "1";

export function assertVillageSlugSuggestConfig(env: LlmEnv = process.env): void {
  if (![undefined, "", "0", "1"].includes(env.VILLAGE_SLUG_SUGGEST)) throw new Error("VILLAGE_SLUG_SUGGEST must be 1, 0 or empty");
  if (env.VILLAGE_SLUG_SUGGEST === "1") villageSlugSuggestConfig(env);
}

export function villageSlugSuggestConfig(env: LlmEnv = process.env) {
  const engine = primaryEngineId(env);
  const model = env.VILLAGE_SLUG_SUGGEST_MODEL?.trim()
    || (engine === "gemini" ? DEFAULT_GEMINI_MODEL : engine === "claude" ? DEFAULT_CLAUDE_MODEL : "fake-village-slug");
  if (!/^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) || !modelMatchesProvider(engine, model)) throw new Error("Invalid VILLAGE_SLUG_SUGGEST_MODEL");
  return { engine, model };
}

export function resolveVillageSlugCompleter(env: LlmEnv = process.env, deps: EngineDeps = {}) {
  const { engine, model } = villageSlugSuggestConfig(env);
  if (engine === "gemini" && !env.GEMINI_API_KEY?.trim() && !deps.geminiClient) throw new Error("Missing slug provider key");
  if (engine === "claude" && !env.ANTHROPIC_API_KEY?.trim() && !deps.claudeClient) throw new Error("Missing slug provider key");
  return { engine, model, async complete(req: CompleteRequest): Promise<Completion> {
    if (engine === "gemini") return geminiComplete(deps.geminiClient ?? createGeminiClient(env.GEMINI_API_KEY!), {
      model, ...req, thinkingLevel: "MINIMAL",
      maxOutputTokens: Math.min(GEMINI_MAX_OUTPUT_TOKENS, req.maxOutputTokens + thinkingHeadroom("MINIMAL")),
    });
    if (engine === "claude") return claudeComplete(deps.claudeClient ?? createClaudeClient(env.ANTHROPIC_API_KEY!), {
      model, system: req.system, user: req.user, maxTokens: req.maxOutputTokens, signal: req.signal,
    });
    return { text: "gathering-place", inputTokens: Math.ceil(Buffer.byteLength(req.system + req.user) / 4), outputTokens: 4 };
  } };
}
