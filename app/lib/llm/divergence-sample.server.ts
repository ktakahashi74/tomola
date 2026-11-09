import { createHash } from "node:crypto";
import { LlmError } from "./errors.server";
import type { LlmEnv } from "./types";

// Divergence sampling. Detection is disabled by default. Even with both TRANSLATION_SECONDARY and DIVERGENCE_JUDGE explicitly configured,
// sample instead of comparing every translation: DIVERGENCE_SAMPLE_RATE (0..1, default 0) selects translations for secondary translation and judging. 0 measures nothing; 1 measures everything
// (the former behavior with secondary and judge configured). Without both engines, this setting changes nothing. Budget degradation still disables secondary and judge.
// Selection depends deterministically only on (post id, target language, source version), so retrying, requeueing or retranslating the same version never changes selection. Measured secondary rows retain the judged flag
// (app/lib/llm/flags.ts), including when no divergence was found. /admin/observation counts it for 「測った訳の数」.

export const DIVERGENCE_SAMPLE_RATE_VAR = "DIVERGENCE_SAMPLE_RATE";

// Sampling rate: unset/empty means 0. Values outside 0..1 throw LlmError(config), stopping production startup (startup-checks.server.ts).
export function divergenceSampleRate(env: LlmEnv = process.env): number {
  const raw = env[DIVERGENCE_SAMPLE_RATE_VAR]?.trim();
  if (raw === undefined || raw === "") return 0;
  const rate = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new LlmError("config", `${DIVERGENCE_SAMPLE_RATE_VAR} must be a number from 0 to 1 (got "${raw}")`);
  return rate;
}

const warned = new Set<string>();

// Runtime rate: invalid values become 0 and warn once. Production never reaches this because startup rejects them.
export function currentDivergenceSampleRate(env: LlmEnv = process.env): number {
  try {
    return divergenceSampleRate(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!warned.has(message)) {
      warned.add(message);
      console.warn(`[llm] ${message}; using 0 (no translation is compared)`);
    }
    return 0;
  }
}

// Value in [0,1) determined by (post id, target language, source version).
export function divergenceSampleValue(key: { entryId: number; lang: string; sourceHash: string }): number {
  const digest = createHash("sha256").update(`divergence-sample\n${key.entryId}\n${key.lang}\n${key.sourceHash}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

// Whether this translation was sampled. Rate 0 always returns false; rate 1 always true.
export function isDivergenceSampled(key: { entryId: number; lang: string; sourceHash: string }, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return divergenceSampleValue(key) < rate;
}
