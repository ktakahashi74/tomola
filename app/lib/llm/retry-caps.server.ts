import { LlmError } from "./errors.server";
import type { LlmEnv } from "./types";

// Daily caps on automatic report retranslation, limiting costs rather than calling a higher-tier expensive model for every report:
//   - TRANSLATION_RETRY_MEMBER_DAILY_MAX: per-member slots in the preceding 24 hours, default 5.
//   - TRANSLATION_RETRY_DAILY_MAX: site-wide slots in the preceding 24 hours, default 30.
// Reports beyond the cap go straight to moderators without taking a retry slot. 0 disables automatic retries; all reports go directly to moderators.
// Count translation_reports rows with retry_slot=true by created_at, including retries that failed or were skipped: their slots stay spent.

export const RETRY_MEMBER_DAILY_MAX_VAR = "TRANSLATION_RETRY_MEMBER_DAILY_MAX";
export const RETRY_DAILY_MAX_VAR = "TRANSLATION_RETRY_DAILY_MAX";
export const DEFAULT_RETRY_MEMBER_DAILY_MAX = 5;
export const DEFAULT_RETRY_DAILY_MAX = 30;

export type RetryCaps = { perMember: number; total: number };

function readCap(env: LlmEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw new LlmError("config", `${name} must be a whole number of 0 or more (got "${raw}")`);
  return value;
}

// Validate caps; invalid values throw LlmError(config), stopping production startup (startup-checks.server.ts).
export function retryCaps(env: LlmEnv = process.env): RetryCaps {
  return { perMember: readCap(env, RETRY_MEMBER_DAILY_MAX_VAR, DEFAULT_RETRY_MEMBER_DAILY_MAX), total: readCap(env, RETRY_DAILY_MAX_VAR, DEFAULT_RETRY_DAILY_MAX) };
}

const warned = new Set<string>();

// Runtime cap: invalid values use defaults and warn once. Production startup rejects them before this point.
export function currentRetryCaps(env: LlmEnv = process.env): RetryCaps {
  try {
    return retryCaps(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!warned.has(message)) {
      warned.add(message);
      console.warn(`[llm] ${message}; using the defaults (${DEFAULT_RETRY_MEMBER_DAILY_MAX} per member and ${DEFAULT_RETRY_DAILY_MAX} in total per day)`);
    }
    return { perMember: DEFAULT_RETRY_MEMBER_DAILY_MAX, total: DEFAULT_RETRY_DAILY_MAX };
  }
}
