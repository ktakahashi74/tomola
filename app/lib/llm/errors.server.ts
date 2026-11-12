import { DeferJob } from "~/lib/jobs/queue.server";
import { BUDGET_RESERVATION_WAIT } from "~/lib/jobs/defer-reasons";
import type { BudgetState } from "./types";

export type LlmErrorCode =
  // The model did not answer, e.g. safety refusal or blocked input.
  | "refusal"
  // Output truncated at the limit.
  | "truncated"
  // Empty output.
  | "empty"
  // Invalid format, such as malformed judge JSON.
  | "invalid_output"
  // Reasoning or excessive expansion persisted after one checked retry.
  | "output_leak"
  // Missing key, invalid configuration value, etc.
  | "config"
  // No engine for the selected role (secondary or judge is none).
  | "unavailable";

// Total job attempts, including the first call. Uncharged configuration errors
// retain the job's own limit; deterministic output failures get fewer attempts.
const MAX_ATTEMPTS: Record<LlmErrorCode, number | undefined> = {
  refusal: 1,
  output_leak: 1,
  truncated: 2,
  empty: 3,
  invalid_output: 3,
  config: undefined,
  unavailable: undefined,
};

// LLM call failure. A job handler can throw it unchanged to trigger retry.
// usage contains charged tokens even when a returned response was unusable due to refusal/truncation; record them in the ledger.
export class LlmError extends Error {
  // Refusals and persistent output leaks fail immediately; another job attempt would only repeat rejected input.
  readonly retryable: boolean;
  readonly maxAttempts: number | undefined;
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly usage?: { inputTokens: number; outputTokens: number; thoughtTokens?: number },
  ) {
    super(message);
    this.name = "LlmError";
    this.maxAttempts = MAX_ATTEMPTS[code];
    this.retryable = this.maxAttempts !== 1;
  }
}

// The settled budget state or insufficient reservation capacity prevents calling. Extends DeferJob: if a handler throws it,
// the job waits without failing until the next budget check (a raised limit may resume it), at latest the next month's start.
export class BudgetPausedError extends DeferJob {
  constructor(
    readonly state: BudgetState,
    until: Date,
    readonly role: "primary" | "secondary" | "retry" | "judge" | "embed" | "chat",
    readonly reason: "state" | "insufficient" = "state",
  ) {
    super(until, reason === "insufficient" ? `llm budget ${state}: insufficient remaining budget for ${role}` : `llm budget ${state}: ${role} disabled`, reason === "insufficient" ? BUDGET_RESERVATION_WAIT : undefined);
    this.name = "BudgetPausedError";
  }
}
