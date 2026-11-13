import { createFigureReader, figureTranslationEnabled } from "./figure-reading.server";
import { judgeThinking, primaryEngineId, resolveEmbeddingEngine, resolveEngines, sourceLanguageConfig, type EngineSet } from "./llm/config.server";
import { postAskAiEnabled } from "./ai-question-config.server";
import { questionModel } from "./ai-question-answer.server";
import { currentDivergenceSampleRate } from "./llm/divergence-sample.server";
import type { EngineId, LlmEnv, TranslationEngine } from "./llm/types";
import type { ThinkingSetting } from "./llm/thinking";
import { aiSpamEnabled, moderationAiConfig, triageEnabled } from "./moderation-ai-config.server";

// Model identifiers are public names, never URLs, credentials or arbitrary configuration text.
export const PUBLIC_MODEL_NAME = /^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ModelConfig = { id: EngineId; model: string; thinking?: ThinkingSetting; dimensions?: number; sampleRate?: number };
type Context = {
  env: LlmEnv;
  engines: EngineSet;
  embedding: ReturnType<typeof resolveEmbeddingEngine>;
  figure: ReturnType<typeof createFigureReader> | null;
  sampleRate: number;
};
type Definition = { label: string; sent: string; current: (context: Context) => ModelConfig | null };

const translation = (engine?: TranslationEngine | null): ModelConfig | null => engine
  ? { id: engine.id, model: engine.model, thinking: engine.thinkingSetting }
  : null;
const moderation = (env: LlmEnv): ModelConfig => {
  const config = moderationAiConfig(env);
  return { id: config.engine, model: config.model };
};

// One row defines a use, its copy and its actual resolver. History validation uses these same IDs.
// Adding a use here does not change engine selection or enable a feature.
export const AI_USE_DEFINITIONS = {
  "translation-primary": { label: "ai_use_primary", sent: "ai_use_sent_post", current: (c: Context) => translation(c.engines.primary) },
  "translation-secondary": { label: "ai_use_secondary", sent: "ai_use_sent_post", current: (c: Context) => translation(c.engines.secondary) },
  "translation-retry": { label: "ai_use_retry", sent: "ai_use_sent_retry", current: (c: Context) => translation(c.engines.retry) },
  "chat-translation": { label: "ai_use_chat", sent: "ai_use_sent_chat", current: (c: Context) => translation(c.engines.chat) },
  "post-ask": { label: "ai_use_post_ask", sent: "ai_use_sent_post_ask", current: (c: Context): ModelConfig | null => postAskAiEnabled(c.env) ? { id: primaryEngineId(c.env), model: questionModel(c.env) } : null },
  "translation-check": { label: "ai_use_judge", sent: "ai_use_sent_judge", current: (c: Context): ModelConfig | null => {
    const judge = c.engines.judge;
    return judge && c.engines.secondary && c.sampleRate > 0
      ? { id: judge.id, model: judge.model, thinking: judge.id === "gemini" ? judgeThinking(c.env) : undefined, sampleRate: c.sampleRate }
      : null;
  } },
  "figure-reading": { label: "ai_use_figure_reading", sent: "ai_use_sent_figure", current: (c: Context): ModelConfig | null => c.figure ? { id: c.figure.id, model: c.figure.model } : null },
  "figure-translation": { label: "ai_use_figure_translation", sent: "ai_use_sent_labels", current: (c: Context) => c.figure ? translation(c.engines.primary) : null },
  "source-language": { label: "ai_use_source_language", sent: "ai_use_sent_source", current: (c: Context): ModelConfig => {
    const config = sourceLanguageConfig(c.env);
    return { id: config.engine, model: config.model };
  } },
  "search-embedding": { label: "ai_use_embedding", sent: "ai_use_sent_embedding", current: (c: Context): ModelConfig => ({ id: c.embedding.id, model: c.embedding.model, dimensions: c.embedding.dim }) },
  "report-triage": { label: "ai_use_triage", sent: "ai_use_sent_triage", current: (c: Context) => triageEnabled(c.env) ? moderation(c.env) : null },
  "spam-detection": { label: "ai_use_spam", sent: "ai_use_sent_spam", current: (c: Context) => aiSpamEnabled(c.env) ? moderation(c.env) : null },
} as const satisfies Record<string, Definition>;

export type AiUsePurpose = keyof typeof AI_USE_DEFINITIONS;
export const AI_USE_PURPOSES = Object.keys(AI_USE_DEFINITIONS) as [AiUsePurpose, ...AiUsePurpose[]];

export function readAiUseConfigurations(env: LlmEnv = process.env) {
  let context: Context;
  try {
    context = {
      env,
      engines: resolveEngines(env),
      embedding: resolveEmbeddingEngine(env),
      figure: figureTranslationEnabled(env) ? createFigureReader(env) : null,
      sampleRate: currentDivergenceSampleRate(env),
    };
    return AI_USE_PURPOSES.map(purpose => ({ purpose, definition: AI_USE_DEFINITIONS[purpose], config: AI_USE_DEFINITIONS[purpose].current(context) }));
  } catch {
    // Resolver errors can contain a supplied value. Never echo them through a public route.
    throw new Error("AI configuration is unavailable");
  }
}
