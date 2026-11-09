import { createClaudeEngine, DEFAULT_CLAUDE_MODEL, type ClaudeClient } from "./engines/claude.server";
import { createFakeEmbeddingEngine } from "./engines/fake-embedding.server";
import { createFakeEngine, createFakeJudge } from "./engines/fake.server";
import { createGeminiEmbeddingEngine, DEFAULT_EMBEDDING_MODEL, type GeminiEmbeddingClient } from "./engines/gemini-embedding.server";
import {
  createGeminiEngine,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_JUDGE_GEMINI_MODEL,
  DEFAULT_SECONDARY_GEMINI_MODEL,
  type GeminiClient,
} from "./engines/gemini.server";
import { LlmError } from "./errors.server";
import { CHAT_THINKING_ENV, DEFAULT_TRANSLATION_THINKING, JUDGE_THINKING_ENV, THINKING_ENV, THINKING_SETTINGS, type ThinkingSetting } from "./thinking";
import { createClaudeJudge, createGeminiJudge } from "./judge.server";
import type { DivergenceJudge, EmbeddingEngine, EngineId, LlmEnv, TranslationEngine } from "./types";
import { villageChatEnabled } from "../village-chat-enabled.server";

export type EngineSet = {
  chat?: TranslationEngine | null;
  primary: TranslationEngine;
  // Secondary engine; null when none.
  secondary: TranslationEngine | null;
  // Divergence judge; null when none.
  judge: DivergenceJudge | null;
  // One automatic retranslation after a report: TRANSLATION_RETRY_MODEL from the primary provider. Unset means null: no automatic retry, straight to moderators.
  // Optional in directly constructed test EngineSets; omission equals null.
  retry?: TranslationEngine | null;
};

// Tests can inject fake clients instead of keys, without network calls.
// log: where the per-call line of the Gemini translation engines goes (default: the log of the process; translations:compare sends it to stderr, because stdout may carry the Markdown).
export type EngineDeps = { geminiClient?: GeminiClient; claudeClient?: ClaudeClient; log?: (line: string) => void };

const value = (env: LlmEnv, name: string) => env[name]?.trim() || undefined;

function choose<T extends string>(env: LlmEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = value(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new LlmError("config", `${name} must be one of: ${allowed.join(", ")} (got "${raw}")`);
}

type Role = "primary" | "secondary" | "chat";

export function chatThinking(env: LlmEnv): ThinkingSetting {
  return choose<ThinkingSetting>(env, CHAT_THINKING_ENV, THINKING_SETTINGS, "off");
}

export function chatTranslationConcurrency(env: LlmEnv = process.env): number {
  const raw = value(env, "CHAT_TRANSLATION_CONCURRENCY") ?? "4";
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > 16) throw new LlmError("config", "CHAT_TRANSLATION_CONCURRENCY must be an integer from 1 to 16");
  return n;
}

// The same for the Gemini divergence judge (DIVERGENCE_JUDGE_THINKING).
export function judgeThinking(env: LlmEnv): ThinkingSetting {
  return choose<ThinkingSetting>(env, JUDGE_THINKING_ENV, THINKING_SETTINGS, DEFAULT_TRANSLATION_THINKING);
}

// How much the Gemini translation engines think (GEMINI_TRANSLATION_THINKING: off | low | default; unset is off). Anything else is a configuration error.
export function translationThinking(env: LlmEnv): ThinkingSetting {
  return choose<ThinkingSetting>(env, THINKING_ENV, THINKING_SETTINGS, DEFAULT_TRANSLATION_THINKING);
}

// Reported-mistranslation retry model (TRANSLATION_RETRY_MODEL). Provider-independent setting name, but the value must name a model from TRANSLATION_PRIMARY's provider
// (e.g. Claude claude-sonnet-5-5 during tests; a higher-tier Gemini model in production). Unset, including empty, returns undefined.
export function retryModelOf(env: LlmEnv): string | undefined {
  return value(env, "TRANSLATION_RETRY_MODEL");
}

// Gemini models by role: primary TRANSLATION_GEMINI_MODEL (default gemini-3.5-flash-lite),
// secondary TRANSLATION_SECONDARY_GEMINI_MODEL (default gemini-3.6-flash; a different model from primary).
function geminiModel(env: LlmEnv, role: Role): string {
  if (role === "chat") return value(env, "CHAT_TRANSLATION_MODEL") ?? DEFAULT_GEMINI_MODEL;
  return role === "primary"
    ? (value(env, "TRANSLATION_GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL)
    : (value(env, "TRANSLATION_SECONDARY_GEMINI_MODEL") ?? DEFAULT_SECONDARY_GEMINI_MODEL);
}

function buildEngine(id: EngineId, role: Role, env: LlmEnv, deps: EngineDeps, setting: string): TranslationEngine {
  switch (id) {
    case "gemini": {
      const apiKey = value(env, "GEMINI_API_KEY");
      if (!apiKey && !deps.geminiClient) throw new LlmError("config", `${setting}=gemini requires GEMINI_API_KEY`);
      return createGeminiEngine({ apiKey, model: geminiModel(env, role), client: deps.geminiClient, thinking: role === "chat" ? chatThinking(env) : translationThinking(env), ...(role === "chat" ? { thinkingEnv: CHAT_THINKING_ENV } : {}), log: deps.log });
    }
    case "claude": {
      const apiKey = value(env, "ANTHROPIC_API_KEY");
      if (!apiKey && !deps.claudeClient) throw new LlmError("config", `${setting}=claude requires ANTHROPIC_API_KEY`);
      return createClaudeEngine({ apiKey, model: (role === "chat" ? value(env, "CHAT_TRANSLATION_MODEL") : value(env, "TRANSLATION_CLAUDE_MODEL")) ?? DEFAULT_CLAUDE_MODEL, client: deps.claudeClient });
    }
    case "fake":
      return createFakeEngine();
  }
}

// Check whether the model belongs to the provider (gemini/claude family; fake accepts anything). Otherwise the mismatch appears only as a 404 on the first call.
export function modelMatchesProvider(provider: EngineId, model: string): boolean {
  if (provider === "gemini") return /^(models\/)?gemini/i.test(model);
  if (provider === "claude") return /^claude/i.test(model);
  return true;
}

// Build a translation engine from provider/model (retranslation, `pnpm translations:compare`). Keys: GEMINI_API_KEY / ANTHROPIC_API_KEY.
// Reject a model from the wrong provider as a configuration error; setting identifies the setting in the error message.
export function createEngineForModel(provider: EngineId, model: string, env: LlmEnv, deps: EngineDeps = {}, setting = "the model"): TranslationEngine {
  if (!modelMatchesProvider(provider, model)) {
    throw new LlmError("config", `${setting} must be a ${provider} model name (got "${model}"): the two models are models of the same provider`);
  }
  switch (provider) {
    case "gemini": {
      const apiKey = value(env, "GEMINI_API_KEY");
      if (!apiKey && !deps.geminiClient) throw new LlmError("config", `${setting} (gemini) requires GEMINI_API_KEY`);
      return createGeminiEngine({ apiKey, model, client: deps.geminiClient, thinking: translationThinking(env), log: deps.log });
    }
    case "claude": {
      const apiKey = value(env, "ANTHROPIC_API_KEY");
      if (!apiKey && !deps.claudeClient) throw new LlmError("config", `${setting} (claude) requires ANTHROPIC_API_KEY`);
      return createClaudeEngine({ apiKey, model, client: deps.claudeClient });
    }
    case "fake":
      return createFakeEngine({ model });
  }
}

// Primary model name: TRANSLATION_GEMINI_MODEL for gemini, TRANSLATION_CLAUDE_MODEL for claude, falling back to provider defaults; fake uses fake-1.
// Used to check whether the retry model matches the primary; warn because it is not a higher-tier retranslation.
export function primaryModelOf(env: LlmEnv = process.env): string {
  const id = primaryEngineId(env);
  if (id === "gemini") return geminiModel(env, "primary");
  if (id === "claude") return value(env, "TRANSLATION_CLAUDE_MODEL") ?? DEFAULT_CLAUDE_MODEL;
  return createFakeEngine().model;
}

// Primary provider: TRANSLATION_PRIMARY; defaults to gemini with GEMINI_API_KEY, otherwise fake.
export function primaryEngineId(env: LlmEnv = process.env): EngineId {
  return choose<EngineId>(env, "TRANSLATION_PRIMARY", ["gemini", "claude", "fake"], value(env, "GEMINI_API_KEY") !== undefined ? "gemini" : "fake");
}

// Retry engine: TRANSLATION_RETRY_MODEL from the primary provider, using the same key. Reject a model from another provider as a configuration error.
function buildRetryEngine(primaryId: EngineId, env: LlmEnv, deps: EngineDeps): TranslationEngine | null {
  const model = retryModelOf(env);
  if (!model) return null;
  if (!modelMatchesProvider(primaryId, model)) {
    throw new LlmError("config", `TRANSLATION_RETRY_MODEL must be a model of the same provider as TRANSLATION_PRIMARY (${primaryId}), such as ${primaryId === "claude" ? "claude-sonnet-5-5" : "a higher Gemini tier"} (got "${model}")`);
  }
  return createEngineForModel(primaryId, model, env, deps, `TRANSLATION_RETRY_MODEL with TRANSLATION_PRIMARY=${primaryId}`);
}

// Select engines from environment variables.
// - TRANSLATION_PRIMARY (gemini | claude | fake): gemini with GEMINI_API_KEY, otherwise fake.
// - TRANSLATION_SECONDARY (gemini | claude | fake | none): default none. Explicit opt-in for fallback on primary refusal/failure and divergence comparison.
// - DIVERGENCE_JUDGE (claude | gemini | fake | none): default none; explicit opt-in only.
// Multi-model divergence detection is disabled by default; enable for research, keeping translation cost and operations lighter. Enabling requires
// both TRANSLATION_SECONDARY and DIVERGENCE_JUDGE. Without a secondary translation engine, translation fallback is unavailable.
// Models: TRANSLATION_GEMINI_MODEL (gemini-3.5-flash-lite), TRANSLATION_SECONDARY_GEMINI_MODEL (gemini-3.6-flash),
// TRANSLATION_CLAUDE_MODEL (claude-haiku-4-5), DIVERGENCE_JUDGE_MODEL (claude: claude-haiku-4-5),
// DIVERGENCE_JUDGE_GEMINI_MODEL (gemini-3.6-flash). Keys: GEMINI_API_KEY, ANTHROPIC_API_KEY.
// TRANSLATION_RETRY_MODEL: one automatic retranslation after a report, from the primary provider. No default; unset disables automatic retry.
// Every engine's rows retain engine and model, so the records show whether primary and secondary used the same provider.
// Explicit engines without their keys throw LlmError(config).
export function resolveEngines(env: LlmEnv = process.env, deps: EngineDeps = {}): EngineSet {
  const hasGemini = value(env, "GEMINI_API_KEY") !== undefined;

  const primaryId = choose<EngineId>(env, "TRANSLATION_PRIMARY", ["gemini", "claude", "fake"], hasGemini ? "gemini" : "fake");
  const secondaryId = choose<EngineId | "none">(env, "TRANSLATION_SECONDARY", ["gemini", "claude", "fake", "none"], "none");
  const judgeId = choose<"claude" | "gemini" | "fake" | "none">(env, "DIVERGENCE_JUDGE", ["claude", "gemini", "fake", "none"], "none");

  let judge: DivergenceJudge | null = null;
  if (judgeId === "fake") judge = createFakeJudge();
  if (judgeId === "claude") {
    const apiKey = value(env, "ANTHROPIC_API_KEY");
    if (!apiKey && !deps.claudeClient) throw new LlmError("config", "DIVERGENCE_JUDGE=claude requires ANTHROPIC_API_KEY");
    judge = createClaudeJudge({ apiKey, model: value(env, "DIVERGENCE_JUDGE_MODEL") ?? DEFAULT_CLAUDE_MODEL, client: deps.claudeClient });
  }
  if (judgeId === "gemini") {
    const apiKey = value(env, "GEMINI_API_KEY");
    if (!apiKey && !deps.geminiClient) throw new LlmError("config", "DIVERGENCE_JUDGE=gemini requires GEMINI_API_KEY");
    judge = createGeminiJudge({ apiKey, model: value(env, "DIVERGENCE_JUDGE_GEMINI_MODEL") ?? DEFAULT_JUDGE_GEMINI_MODEL, client: deps.geminiClient, thinking: judgeThinking(env) });
  }

  return {
    chat: villageChatEnabled(env) ? resolveChatEngine(env, deps) : null,
    primary: buildEngine(primaryId, "primary", env, deps, "TRANSLATION_PRIMARY"),
    secondary: secondaryId === "none" ? null : buildEngine(secondaryId, "secondary", env, deps, "TRANSLATION_SECONDARY"),
    judge,
    retry: buildRetryEngine(primaryId, env, deps),
  };
}

// Reuse the selected primary provider and fake switch, with separate chat model
// and thinking settings. Resolving this engine never makes a provider call.
export function resolveChatEngine(env: LlmEnv = process.env, deps: EngineDeps = {}): TranslationEngine {
  const provider = primaryEngineId(env);
  const model = value(env, "CHAT_TRANSLATION_MODEL");
  chatThinking(env);
  if (model && !modelMatchesProvider(provider, model)) throw new LlmError("config", `CHAT_TRANSLATION_MODEL must be a ${provider} model name`);
  return buildEngine(provider, "chat", env, deps, "CHAT_TRANSLATION_MODEL");
}

// Whether divergence detection is enabled: both secondary and judge are explicitly configured (TRANSLATION_SECONDARY and DIVERGENCE_JUDGE). Disabled by default.
// Treat configuration errors such as missing keys as disabled for the observation UI; startup validation throws separately.
export function divergenceDetectionEnabled(env: LlmEnv = process.env): boolean {
  try {
    const set = resolveEngines(env);
    return set.secondary !== null && set.judge !== null;
  } catch {
    return false;
  }
}

// Embedding engine for semantic search.
// - EMBEDDING_ENGINE (gemini | fake): gemini with GEMINI_API_KEY, otherwise fake for keyless development/tests; deterministic and free.
//   Explicit gemini without a key throws LlmError(config).
// - EMBEDDING_MODEL: Gemini model name (default gemini-embedding-001; 768-dimensional output). Stored in each row's model, so changing models
//   excludes older-model rows from search; rebuild with pnpm embeddings:backfill.
export type EmbeddingDeps = { geminiEmbeddingClient?: GeminiEmbeddingClient };

export function resolveEmbeddingEngine(env: LlmEnv = process.env, deps: EmbeddingDeps = {}): EmbeddingEngine {
  const apiKey = value(env, "GEMINI_API_KEY");
  const id = choose<"gemini" | "fake">(env, "EMBEDDING_ENGINE", ["gemini", "fake"], apiKey ? "gemini" : "fake");
  if (id === "fake") return createFakeEmbeddingEngine();
  if (!apiKey && !deps.geminiEmbeddingClient) throw new LlmError("config", "EMBEDDING_ENGINE=gemini requires GEMINI_API_KEY");
  return createGeminiEmbeddingEngine({ apiKey, model: value(env, "EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL, client: deps.geminiEmbeddingClient });
}

// Current embedding model name, for observations to use only that model's rows. Returns null on configuration errors such as missing keys.
export function currentEmbeddingModel(env: LlmEnv = process.env): string | null {
  try {
    return resolveEmbeddingEngine(env).model;
  } catch {
    return null;
  }
}
