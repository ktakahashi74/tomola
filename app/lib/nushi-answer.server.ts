import { answerVerificationFailure, verifyQuestionAnswerResult, type AnswerVerificationFailure } from "./ai-question-answer.server";
import type { AiQuestionMaterials } from "./ai-question-materials.server";
import { AI_QUESTION_LIMITS } from "./ai-questions";

export function verifyNushiAnswer(raw: string, materials: AiQuestionMaterials, destination: "public-reply" | "chat" = "public-reply") {
  const result = verifyNushiAnswerResult(raw, materials, destination);
  return result.ok ? { answer: result.answer, clarificationNeeded: result.clarificationNeeded } : null;
}

export function logNushiVerificationFailure(requestId: string, result: AnswerVerificationFailure) {
  console.warn("Nushi answer verification failed", { requestId, reason: result.reason, counts: { readings: result.counts.readings, citations: result.counts.citations } });
}

export function verifyNushiAnswerResult(raw: string, materials: AiQuestionMaterials, destination: "public-reply" | "chat" = "public-reply") {
  if (raw.length > AI_QUESTION_LIMITS.outputChars) return answerVerificationFailure("output_too_long");
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")); }
  catch { return answerVerificationFailure("not_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return answerVerificationFailure("schema");
  const { askPerson, ...answerData } = value as Record<string, unknown>;
  if (askPerson !== undefined && typeof askPerson !== "boolean") return answerVerificationFailure("schema", value);
  let clarificationNeeded = false;
  if (destination === "chat") {
    if (answerData.clarificationNeeded !== undefined && typeof answerData.clarificationNeeded !== "boolean") return answerVerificationFailure("schema", value);
    clarificationNeeded = answerData.clarificationNeeded === true;
    delete answerData.clarificationNeeded;
  }
  if (answerData.status === "not_confirmed" && answerData.readings === undefined) answerData.readings = [];
  const result = verifyQuestionAnswerResult(JSON.stringify(answerData), materials);
  if (!result.ok) return result;
  if (result.answer.status === "not_confirmed") result.answer.askPerson = askPerson === true;
  return { ...result, clarificationNeeded: result.answer.status === "not_confirmed" && clarificationNeeded };
}
