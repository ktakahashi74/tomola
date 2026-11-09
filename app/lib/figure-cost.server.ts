import { primaryEngineId, primaryModelOf, translationThinking } from "./llm/config.server";
import { buildTranslationPrompt, estimateTokens } from "./llm/prompt.server";
import { costMicro, priceFor } from "./llm/pricing.server";
import { THINKING_LADDER, thinkingHeadroom } from "./llm/thinking";
import type { GlossaryHint, LlmEnv } from "./llm/types";
import { createFigureReader, FIGURE_READING_PROMPT } from "./figure-reading.server";
import type { Lang } from "./languages";

export const FIGURE_COST_ASSUMPTIONS = {
  labels: Array.from({ length: 20 }, (_, i) => `Evidence ${i + 1}: a sample label`),
  glossary: [{ term: "Evidence", candidates: ["根拠"] }, { term: "sample", candidates: ["見本"] }] satisfies GlossaryHint[],
  messageFramingTokens: 64,
  readingOutputTokens: 2000,
  translationTextOutputTokens: 500,
};

// Configuration and arithmetic only: never construct a provider client or make
// a model call while previewing a backfill. Model prices honor existing overrides.
export function figureCostProfile(env: LlmEnv = process.env) {
  const reader = createFigureReader(env);
  const engine = primaryEngineId(env), model = primaryModelOf(env);
  const thinking = engine === "gemini" ? translationThinking(env) : "off";
  const reasoningTokens = engine === "gemini" ? thinkingHeadroom(THINKING_LADDER[thinking][0]) : 0;
  const describe = (id: string, name: string) => id === "fake" ? { engine: id, model: name, priceSource: "fake", inputUsdPerMillion: 0, outputUsdPerMillion: 0 } : (() => {
    const { price, source } = priceFor(name, env, id);
    return { engine: id, model: name, priceSource: source, inputUsdPerMillion: price.inputNano / 1000, outputUsdPerMillion: price.outputNano / 1000 };
  })();
  const imageTokens = reader.id === "claude" ? 1500 : 1120;
  const readingInputTokens = estimateTokens(FIGURE_READING_PROMPT + "Read the labels and bounding boxes in the attached image.") + FIGURE_COST_ASSUMPTIONS.messageFramingTokens + imageTokens;
  return {
    reader: { ...describe(reader.id, reader.model), imageTokens, inputTokens: readingInputTokens, outputTokens: FIGURE_COST_ASSUMPTIONS.readingOutputTokens,
      estimatedUsdMicro: costMicro(reader.id, reader.model, readingInputTokens, FIGURE_COST_ASSUMPTIONS.readingOutputTokens, env) },
    primary: { ...describe(engine, model), thinking, reasoningAllowanceTokens: reasoningTokens },
  };
}

export function estimateFigureTranslation(profile: ReturnType<typeof figureCostProfile>, from: Lang, to: Lang, env: LlmEnv, labels: readonly string[] = FIGURE_COST_ASSUMPTIONS.labels, glossary: GlossaryHint[] = FIGURE_COST_ASSUMPTIONS.glossary) {
  const prompt = buildTranslationPrompt({ text: JSON.stringify(labels), from, to, figure: true, glossary }, "cost-estimate");
  const inputTokens = estimateTokens(prompt.system + prompt.user) + FIGURE_COST_ASSUMPTIONS.messageFramingTokens;
  const outputTokens = FIGURE_COST_ASSUMPTIONS.translationTextOutputTokens;
  const { engine, model, reasoningAllowanceTokens } = profile.primary;
  return { inputTokens, textOutputTokens: outputTokens, reasoningAllowanceTokens,
    textOnlyUsdMicro: costMicro(engine, model, inputTokens, outputTokens, env),
    estimatedUsdMicro: costMicro(engine, model, inputTokens, outputTokens + reasoningAllowanceTokens, env) };
}
