import type { Db } from "./db/client.server";
import type { AiQuestionMaterials } from "./ai-question-materials.server";
import { normalizeQuestionQuote, type AnswerVerificationReason } from "./ai-question-answer.server";
import { AI_QUESTION_LIMITS as limits, type AiQuestionAnswer } from "./ai-questions";
import { verifyNushiAnswerResult } from "./nushi-answer.server";
import type { CompleteRequest, JsonCompleter } from "./llm/completion.server";
import { completionEstimate, meteredCall } from "./llm/metering.server";
import type { LlmEnv } from "./llm/types";

const limitReasons = new Set<AnswerVerificationReason>(["readings_count", "citations_count", "reading_too_long", "quote_too_long", "output_too_long"]);
type RawCitation = { sourceId: string; quote: string; translatedQuote?: string };
type RawAnswer = { readings: Array<{ text: string; citations: RawCitation[] }> };

// Called only after checking the full structure and content with relaxed limits.
function excesses(raw: string) {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")) as RawAnswer;
  const readings = value.readings ?? [];
  const citations = readings.flatMap(reading => reading.citations);
  const distinct = new Set(citations.map(c => JSON.stringify([c.sourceId, normalizeQuestionQuote(c.quote), c.translatedQuote ? normalizeQuestionQuote(c.translatedQuote) : undefined]))).size;
  return [
    { reason: "readings_count", actual: readings.length, limit: limits.readings },
    { reason: "citations_count", actual: Math.max(distinct, ...readings.map(r => r.citations.length)), limit: limits.citations },
    { reason: "reading_too_long", actual: Math.max(0, ...readings.map(r => r.text.trim().length)), limit: limits.readingChars },
    { reason: "quote_too_long", actual: Math.max(0, ...citations.flatMap(c => [c.quote.trim().length, c.translatedQuote?.trim().length ?? 0])), limit: limits.quoteChars },
    { reason: "output_too_long", actual: raw.length, limit: limits.outputChars },
  ].filter(item => item.actual > item.limit);
}

function boundedAnswer(answer: AiQuestionAnswer) {
  const kept = new Set<number>();
  const readings = answer.readings.slice(0, limits.readings).flatMap(reading => {
    const citations = reading.citations.filter(index => {
      if (kept.has(index)) return true;
      if (kept.size >= limits.citations) return false;
      kept.add(index);
      return true;
    }).map(index => {
      const citation = answer.citations[index - 1];
      return { sourceId: citation.sourceId, quote: citation.original.quote, ...(citation.translation ? { translatedQuote: citation.translation.quote } : {}) };
    });
    return citations.length ? [{ text: reading.text, citations }] : [];
  });
  return JSON.stringify({ status: answer.status, readings });
}

export async function completeNushiAnswer(db: Db, completer: JsonCompleter, prompt: CompleteRequest, materials: AiQuestionMaterials,
  options: { destination?: "public-reply" | "chat"; clock: () => Date; env: LlmEnv }) {
  const { destination = "public-reply", clock, env } = options;
  const complete = async (request: CompleteRequest) => {
    const { result } = await meteredCall(db, { engine: completer.engine, model: completer.model, purpose: "ask_village", role: "ask",
      estimateMicro: completionEstimate(completer.engine, completer.model, request.system, request.user, request.maxOutputTokens, env), now: clock(), clock, env, signal: request.signal },
    () => completer.complete(request), value => ({ inputTokens: value.inputTokens, outputTokens: value.outputTokens }));
    return result.text;
  };
  let raw = await complete(prompt);
  let verified = verifyNushiAnswerResult(raw, materials, destination);
  if (verified.ok || !limitReasons.has(verified.reason)) return { ...verified, truncated: false };
  // A size failure must never conceal an invalid quote, source or extra field.
  const content = verifyNushiAnswerResult(raw, materials, destination, { ignoreCounts: true, ignoreLengths: true });
  if (!content.ok) return { ...content, truncated: false };
  const exceeded = excesses(raw);
  if (!exceeded.length) return { ...verified, truncated: false };
  console.info("Nushi answer regeneration", { limits: exceeded });
  raw = await complete({ ...prompt, system: prompt.system + `\nThe previous answer exceeded these limits: ${exceeded.map(item => `${item.reason}: ${item.actual}, limit ${item.limit}`).join("; ")}. Return a shorter answer in the same JSON shape using the same supplied materials. Preserve attribution, conditions and reservations. This is the only regeneration.` });
  verified = verifyNushiAnswerResult(raw, materials, destination);
  if (verified.ok || !["citations_count", "readings_count"].includes(verified.reason)) return { ...verified, truncated: false };
  const countOnly = verifyNushiAnswerResult(raw, materials, destination, { ignoreCounts: true });
  if (!countOnly.ok) return { ...countOnly, truncated: false };
  const bounded = verifyNushiAnswerResult(boundedAnswer(countOnly.answer), materials, destination);
  if (!bounded.ok) return { ...bounded, truncated: false };
  console.info("Nushi answer bounded", { reason: verified.reason, before: verified.counts, after: { readings: bounded.answer.readings.length, citations: bounded.answer.citations.length } });
  return { ...bounded, truncated: true };
}
