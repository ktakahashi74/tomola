import { AI_QUESTION_LIMITS } from "./ai-questions";
import type { LlmEnv } from "./llm/types";

export const postAskAiEnabled = (env: LlmEnv = process.env) => env.POST_ASK_AI === "1";

function positiveInteger(env: LlmEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() || String(fallback);
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new Error(`${name} must be an integer from 1 to 1000000`);
  return n;
}

export function postAskMonthlyBudgetMicro(env: LlmEnv = process.env): number {
  const raw = env.POST_ASK_AI_LLM_MONTHLY_BUDGET_USD?.trim() || String(AI_QUESTION_LIMITS.monthlyBudgetUsd);
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 1_000_000))) throw new Error("POST_ASK_AI_LLM_MONTHLY_BUDGET_USD must be a non-negative finite number");
  return Math.round(n * 1_000_000);
}

export function aiQuestionLimits(env: LlmEnv = process.env) {
  return {
    member: { limit: positiveInteger(env, "ASK_AI_MEMBER_DAILY_LIMIT", AI_QUESTION_LIMITS.memberDaily), windowSeconds: 86_400 },
    ip: {
      limit: positiveInteger(env, "ASK_AI_IP_LIMIT", AI_QUESTION_LIMITS.ipLimit),
      windowSeconds: positiveInteger(env, "ASK_AI_IP_WINDOW_SECONDS", AI_QUESTION_LIMITS.ipWindowSeconds),
    },
  };
}

export function assertAiQuestionConfig(env: LlmEnv = process.env): void {
  if (![undefined, "", "0", "1"].includes(env.POST_ASK_AI)) throw new Error("POST_ASK_AI must be 1, 0 or empty");
  if (!postAskAiEnabled(env)) return;
  aiQuestionLimits(env);
  postAskMonthlyBudgetMicro(env);
}
