import type { Lang } from "./languages";

export const AI_QUESTION_LIMITS = {
  questionChars: 2_000,
  materialChars: 24_000,
  sourceChars: 8_000,
  replies: 40,
  readings: 4,
  readingChars: 1_200,
  citations: 8,
  quoteChars: 600,
  fragmentChars: 80,
  outputTokens: 4_096,
  outputChars: 32_000,
  requestBytes: 96 * 1_024,
  receiptSeconds: 3_600,
  monthlyBudgetUsd: 10,
  memberDaily: 10,
  ipLimit: 6,
  ipWindowSeconds: 600,
} as const;

export const AI_QUESTION_PURPOSES = ["ask", "ask_village"] as const;
export type AiQuestionPurpose = typeof AI_QUESTION_PURPOSES[number];
export type AiQuestionTarget = { kind: "post"; id: number } | { kind: "village"; id: string };
export type AiQuestionScope = { replies: number; sources: number; truncated: boolean };
export type AiQuestionCitation = {
  sourceId: string;
  kind: "post" | "reply";
  author: string;
  field: "title" | "body";
  original: { quote: string; lang: string; href: string };
  translation?: { quote: string; lang: Lang; href: string; stale: boolean };
};
export type AiQuestionAnswer = {
  status: "answered" | "not_confirmed";
  readings: Array<{ text: string; citations: number[] }>;
  citations: AiQuestionCitation[];
};
export type AiQuestionContent = {
  answer: AiQuestionAnswer;
  scope: AiQuestionScope;
  language: Lang;
  engine: string;
  model: string;
  expiresAt: number;
};
export type AiQuestionResponse = AiQuestionContent & { receipt: string };
export const AI_QUESTION_ERRORS = ["invalid", "not_found", "daily_limit", "ip_limit", "budget", "unverified", "expired", "unavailable"] as const;
export type AiQuestionError = typeof AI_QUESTION_ERRORS[number];

// Preserve UTF-16 boundaries when limiting material or a text-fragment prefix.
export function clipQuestionText(text: string, max: number): string {
  let end = Math.min(text.length, Math.max(0, max));
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
