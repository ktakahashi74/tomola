import { MAX_TRANSLATION_TIMEOUT_MS } from "./llm/request-timeout";

// Allow another minute for queue pickup and a final status check.
export const BODY_TRANSLATION_WAIT_MS = MAX_TRANSLATION_TIMEOUT_MS + 60_000;

export function bodyTranslationPollDelay(round: number, remainingMs: number): number {
  return Math.min(3_000 * 2 ** round, 30_000, Math.max(0, remainingMs));
}
