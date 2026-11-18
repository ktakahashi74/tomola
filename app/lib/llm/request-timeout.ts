export const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

// Long post translations measured about 110 output tokens/second. Allow 60/s of
// the visible-output cap plus a minute for startup, with a two-minute floor and
// a fifteen-minute cap. Provider configuration fallbacks share this deadline.
export const translationTimeoutMs = (maxOutputTokens: number): number =>
  Math.min(15 * 60 * 1000, Math.max(REQUEST_TIMEOUT_MS, Math.ceil(maxOutputTokens / 60 * 1000) + 60_000));
