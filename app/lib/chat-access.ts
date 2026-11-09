import { RETENTION } from "./retention";
export const CHAT_AI_TRIAGE_REASON = "chat:ai_triage";
export const CHAT_REPORT_REVIEW_REASON = "chat:report_review";
export const CHAT_APPEAL_REVIEW_REASON = "chat:appeal_review";
// Keep expansion accounting separate from user text without adding a database column.
export const CHAT_EXPAND_REASON_PREFIX = "chat:expand:";
export const CHAT_CASE_EXPAND_LIMIT = 3;
export const CHAT_CASE_CONTEXT_COUNT = 10;
export const CHAT_REPORT_RETAIN_DAYS = RETENTION.chatReportDays;

export function chatAccessFreeReason(reason: string) {
  return reason.startsWith(CHAT_EXPAND_REASON_PREFIX) ? reason.slice(CHAT_EXPAND_REASON_PREFIX.length) : reason;
}
