import { parseQuestionJson, answerVerificationFailure, verifyQuestionAnswerResult, type AnswerVerificationFailure, type AnswerVerificationOptions } from "./ai-question-answer.server";
import type { AiQuestionMaterials } from "./ai-question-materials.server";
import { AI_QUESTION_LIMITS } from "./ai-questions";
import { HANDLE_REST, mentionCandidates } from "./mention-syntax";

export function verifyNushiAnswer(raw: string, materials: AiQuestionMaterials, destination: "public-reply" | "chat" = "public-reply") {
  const result = verifyNushiAnswerResult(raw, materials, destination);
  return result.ok ? { answer: result.answer, clarificationNeeded: result.clarificationNeeded } : null;
}

export function logNushiVerificationFailure(requestId: string, result: AnswerVerificationFailure) {
  console.warn("Nushi answer verification failed", { requestId, reason: result.reason, counts: { readings: result.counts.readings, citations: result.counts.citations } });
}

export function verifyNushiAnswerResult(raw: string, materials: AiQuestionMaterials, destination: "public-reply" | "chat" = "public-reply", options: AnswerVerificationOptions & { voiceApplied?: boolean } = {}) {
  if (!options.ignoreLengths && raw.length > AI_QUESTION_LIMITS.outputChars) return answerVerificationFailure("output_too_long");
  let value: unknown;
  try { value = parseQuestionJson(raw); }
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
  const result = verifyQuestionAnswerResult(JSON.stringify(answerData), materials, options);
  if (!result.ok) return result;
  const authors = new Set(materials.sources.map(source => source.author.normalize("NFKC").toLowerCase()).filter(author => author.startsWith("@")));
  // Match whole URLs so a supplied address never authorizes a longer, different address.
  const urls = (text: string) => text.match(/(?:https?:\/\/|www\.)[^\s<>"'`\[\]{}]+/giu)?.map(url => url.replace(/[.,;:!?。、）)]+$/u, "")) ?? [];
  const allowedUrls = new Set(options.voiceApplied ? materials.sources.flatMap(source => urls(source.original)) : []);
  for (const reading of result.answer.readings) {
    if (options.voiceApplied && urls(reading.text).some(url => !allowedUrls.has(url))) return answerVerificationFailure("unexpected_url", answerData);
    if (mentionCandidates(reading.text).some(({ start, end }) => !authors.has(reading.text.slice(start, end).normalize("NFKC").toLowerCase())
      || HANDLE_REST.test((reading.text[end] ?? "").normalize("NFKC").toLowerCase()))) return answerVerificationFailure("unknown_author", answerData);
  }
  if (result.answer.status === "not_confirmed") result.answer.askPerson = askPerson === true;
  return { ...result, clarificationNeeded: result.answer.status === "not_confirmed" && clarificationNeeded };
}
