// Deliberately allow-list outages; malformed output and refusal must never gain
// another paid attempt merely because they exhausted the queue's retry limit.
export function isTransientFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; code?: string; name?: string; message?: string; retryable?: boolean };
  if (e.retryable === false || e.name === "LlmError") return false;
  if (e.status === 429 || e.status === 408 || (typeof e.status === "number" && e.status >= 500 && e.status <= 599)) return true;
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND)$/.test(e.code ?? "") || transientFailureMessage(`${e.name ?? ""}: ${e.message ?? ""}`);
}

export function transientFailureMessage(message: string): boolean {
  if (/LlmError:|refusal|structure[_ ]mismatch|link[_ ]mismatch|invalid[_ ]output|untranslated/i.test(message)) return false;
  return /^transient:|\b(429|408|5\d\d)\b|budget (?:stopped|limit|exceeded)|llm budget|timed?\s*out|timeout|network|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND/i.test(message);
}

export function canRetryTranslationDaily(kind: string, message: string, payload: unknown): boolean {
  const count = (payload as { automaticRetryCount?: number } | null)?.automaticRetryCount;
  return ["translate_entry", "translate_title"].includes(kind) && transientFailureMessage(message) && !(Number.isInteger(count) && count! >= 3);
}
