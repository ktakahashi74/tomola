// Conservative, deterministic signals. Rate limits still reject excessive requests separately.
export const ABUSE_THRESHOLDS = {
  windowMs: 60_000,
  history: 20,
  duplicateWindowMs: 10 * 60_000,
  duplicateMinLength: 20,
  duplicateCount: 2,
  duplicatePoints: 7,
  chatDuplicatePoints: 3,
  burstCount: 8,
  burstPoints: 3,
  floodCount: 12,
  floodPoints: 7,
  chatFloodCount: 18,
  chatFloodPoints: 3,
  disabledRecheckMs: 60 * 60_000,
  linkCount: 4,
  linkPoints: 3,
  promotionPoints: 4,
  suspicious: 3,
  hide: 7,
  newAuthorPosts: 5,
  aiConfidence: 0.98,
  entryContext: 2,
  chatContext: 10,
} as const;

const canonical = (body: string) => body.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
export function externalLinkCount(body: string, ownOrigin?: string): number {
  return (body.match(/https?:\/\/[^\s<>\])]+/giu) ?? []).filter(raw => {
    try { return new URL(raw).origin !== ownOrigin; } catch { return false; }
  }).length;
}
// The caller limits previous bodies to the repetition time window.
export function scoreAbuse(input: { body: string; previous: readonly string[]; recentCount: number; ownOrigin?: string; chat?: boolean }) {
  const t = ABUSE_THRESHOLDS, signals: string[] = [];
  let score = 0;
  const links = externalLinkCount(input.body, input.ownOrigin);
  const normalized = canonical(input.body);
  if ([...normalized].length >= t.duplicateMinLength && /[\p{L}\p{N}]/u.test(normalized) && input.previous.filter(body => canonical(body) === normalized).length >= t.duplicateCount) { score += input.chat ? t.chatDuplicatePoints : t.duplicatePoints; signals.push("repetition"); }
  if (input.chat) {
    if (input.recentCount >= t.chatFloodCount) { score += t.chatFloodPoints; signals.push("flood"); }
  } else if (input.recentCount >= t.floodCount) { score += t.floodPoints; signals.push("flood"); }
  else if (input.recentCount >= t.burstCount) { score += t.burstPoints; signals.push("burst"); }
  if (links >= t.linkCount) { score += t.linkPoints; signals.push("links"); }
  if (links > 0 && /\b(?:buy now|guaranteed profit|double your money|earn money fast|claim your prize)\b|必ず儲かる|今すぐ購入|当選おめでとう/iu.test(input.body)) { score += t.promotionPoints; signals.push("promotion"); }
  return { score, links, signals };
}
