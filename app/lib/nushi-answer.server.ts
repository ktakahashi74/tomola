import { verifyQuestionAnswer } from "./ai-question-answer.server";
import type { AiQuestionMaterials } from "./ai-question-materials.server";
import { AI_QUESTION_LIMITS } from "./ai-questions";

export function verifyNushiAnswer(raw: string, materials: AiQuestionMaterials, destination: "public-reply" | "chat" = "public-reply") {
  if (raw.length > AI_QUESTION_LIMITS.outputChars) return null;
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { askPerson, ...answerData } = value as Record<string, unknown>;
  if (askPerson !== undefined && typeof askPerson !== "boolean") return null;
  let clarificationNeeded = false;
  if (destination === "chat") {
    if (answerData.clarificationNeeded !== undefined && typeof answerData.clarificationNeeded !== "boolean") return null;
    clarificationNeeded = answerData.clarificationNeeded === true;
    delete answerData.clarificationNeeded;
  }
  if (answerData.status === "not_confirmed" && answerData.readings === undefined) answerData.readings = [];
  const answer = verifyQuestionAnswer(JSON.stringify(answerData), materials);
  if (answer?.status === "not_confirmed") answer.askPerson = askPerson === true;
  return answer ? { answer, clarificationNeeded: answer.status === "not_confirmed" && clarificationNeeded } : null;
}
