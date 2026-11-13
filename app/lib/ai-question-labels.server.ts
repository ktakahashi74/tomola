import { m } from "~/paraglide/messages.js";
import { AI_QUESTION_LIMITS } from "./ai-questions";
import { aiQuestionLimits } from "./ai-question-config.server";
import { RETENTION } from "./retention";

// Keep optional question wording in route data, out of reading-page scripts.
export function aiQuestionLabels() {
  return {
    title: m.post_ask_entry(), intro: m.post_ask_intro({ replies: AI_QUESTION_LIMITS.replies }),
    privacy: m.post_ask_privacy(), question: m.post_ask_question(), submit: m.post_ask_submit(), busy: m.post_ask_busy(),
    answerFor: m.post_ask_answer_for(), reading: m.post_ask_reading(), materials: m.ai_material_title(), posts: m.post_ask_post_passages(), replies: m.post_ask_reply_passages(),
    generatedTranslation: m.ai_material_quote_translation(), original: m.post_ask_original(), translation: m.post_ask_translation(), stale: m.post_ask_translation_stale(),
    scope: m.post_ask_scope({ replies: "{replies}" }), truncated: m.post_ask_truncated(), notConfirmed: m.post_ask_not_confirmed(),
    toAuthor: m.post_ask_to_author(), draftNotice: m.post_ask_draft_notice(), report: m.post_ask_report(),
    reportConsent: m.post_ask_report_consent({ days: RETENTION.aiQuestionReportDays }), reportSend: m.post_ask_report_send(), reported: m.post_ask_reported(),
    back: m.post_ask_back(), daily: m.post_ask_daily_limit({ count: aiQuestionLimits().member.limit }),
    errors: {
      invalid: m.post_ask_error_invalid(), not_found: m.post_ask_error_not_found(), daily_limit: m.post_ask_error_daily_limit(),
      ip_limit: m.post_ask_error_ip_limit(), budget: m.post_ask_error_budget(), unverified: m.post_ask_error_unverified(),
      expired: m.post_ask_error_expired(), unavailable: m.post_ask_error_unavailable(),
    },
  };
}
export type AiQuestionLabels = ReturnType<typeof aiQuestionLabels>;
