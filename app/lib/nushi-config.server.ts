import { publicReading } from "./public-reading.server";
import { villagesEnabled } from "./villages-enabled.server";
import type { LlmEnv } from "./llm/types";
import { modelMatchesProvider, primaryEngineId, primaryModelOf } from "./llm/config.server";

export const NUSHI_PROMPT_VERSION = "nushi-v3";
export const nushiEnabled = (env: LlmEnv = process.env) => env.VILLAGE_NUSHI === "1";
const integer = (env: LlmEnv, key: string, fallback: number) => {
  const raw = env[key]?.trim() || String(fallback), value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`Invalid ${key}`);
  return value;
};
export function nushiLimits(env: LlmEnv = process.env) {
  return {
    member: integer(env, "VILLAGE_NUSHI_MEMBER_DAILY_LIMIT", 5),
    topic: integer(env, "VILLAGE_NUSHI_TOPIC_DAILY_LIMIT", 10),
    village: integer(env, "VILLAGE_NUSHI_VILLAGE_DAILY_LIMIT", 30),
    author: integer(env, "VILLAGE_NUSHI_AUTHOR_DAILY_LIMIT", 10),
    concurrent: integer(env, "VILLAGE_NUSHI_CONCURRENT_LIMIT", 2),
    ttlSeconds: integer(env, "VILLAGE_NUSHI_TTL_SECONDS", 3600),
  };
}
export function nushiMonthlyBudgetMicro(env: LlmEnv = process.env) {
  const raw = env.VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD?.trim() || "10", value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 1_000_000))) throw new Error("Invalid VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD");
  return Math.round(value * 1_000_000);
}
export function nushiModel(env: LlmEnv = process.env) {
  const model = env.VILLAGE_NUSHI_MODEL?.trim() || primaryModelOf(env);
  if (!/^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) || !modelMatchesProvider(primaryEngineId(env), model)) throw new Error("Invalid VILLAGE_NUSHI_MODEL");
  return model;
}
export function nushiInVillage(village: { kind: string; language: string | null; slug: string | null; endedAt: Date | null; nushiEnabled: boolean | null }, env: LlmEnv = process.env) {
  return nushiEnabled(env) && publicReading(env) && villagesEnabled(env) && !village.language && !village.endedAt
    && (village.kind === "personal" ? village.nushiEnabled === true
      : !!village.slug && ["open", "invite_public"].includes(village.kind) && village.nushiEnabled !== false);
}

export function assertNushiConfig(env: LlmEnv = process.env) {
  if (![undefined, "", "0", "1"].includes(env.VILLAGE_NUSHI)) throw new Error("VILLAGE_NUSHI must be 1, 0 or empty");
  if (![undefined, "", "0", "1"].includes(env.VILLAGE_CHAT_NUSHI)) throw new Error("VILLAGE_CHAT_NUSHI must be 1, 0 or empty");
  if (!nushiEnabled(env) && env.VILLAGE_CHAT_NUSHI !== "1") return;
  nushiLimits(env); nushiMonthlyBudgetMicro(env); nushiModel(env);
}
