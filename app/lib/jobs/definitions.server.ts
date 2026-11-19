import { z } from "zod";
import { LANGS } from "../languages";
import { SEND_ACCOUNT_DELETED_JOB, SEND_DIGEST_JOB, SEND_MEMBER_DIGEST_JOB, SEND_NOTIFICATION_EMAIL_JOB, SEND_PASSKEY_NOTICE_JOB } from "./mail-kinds";

const id = z.number().int().positive();
const lang = z.enum(LANGS);
const compactId = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const dated = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const notice = z.object({ notificationId: id });
const source = z.object({ entryId: id, sourceHash: z.string().min(1) });
const postTranslation = source.extend({
  lang,
  redoFlagged: z.literal(true).optional(),
});
const postTranslationAttempt = postTranslation.extend({ primaryRefused: z.boolean().optional() });
const figureKey = z.string().regex(/^[a-f0-9]{64}:v[1-9]\d{0,5}$/);
const nushiRequest = z.object({ requestId: z.string().min(1) });

export const DEFAULT_JOB_PRIORITY = 3;

export const jobDefinitions = {
  answer_nushi: { schema: nushiRequest, priority: 1 },
  answer_chat_nushi: { schema: nushiRequest, priority: 1 },
  email_nushi_result: { schema: notice, priority: DEFAULT_JOB_PRIORITY },
  email_chat_nushi_result: { schema: notice, priority: DEFAULT_JOB_PRIORITY },
  translate_nushi: { schema: z.object({ answerId: id, lang }), priority: DEFAULT_JOB_PRIORITY },
  check_source_language: {
    schema: z.object({ entryId: id, sourceHash: z.string(), revision: z.number().int(), checked: z.boolean().optional() }),
    priority: DEFAULT_JOB_PRIORITY,
  },
  send_push: { schema: z.object({ deliveryId: id }), priority: DEFAULT_JOB_PRIORITY },
  prepare_figures: { schema: z.strictObject({ entryId: id }), priority: 4 },
  read_figure: { schema: z.strictObject({ key: figureKey }), priority: 4 },
  translate_figure: { schema: z.strictObject({ key: figureKey, mediaId: hash, lang }), priority: 4 },
  [SEND_ACCOUNT_DELETED_JOB]: {
    // After delivery the worker keeps only the request ID.
    schema: z.object({ requestId: z.string().min(1), to: z.string().nullish(), posts: z.string().nullish(), locale: z.string().nullish() }),
    priority: 0,
  },
  moderation_spam: { schema: z.strictObject(source.shape), priority: DEFAULT_JOB_PRIORITY },
  moderation_triage: { schema: z.strictObject({ reportId: id }), priority: DEFAULT_JOB_PRIORITY },
  refresh_edited_body: { schema: z.object({ entryId: id, lang }), priority: DEFAULT_JOB_PRIORITY },
  translate_title: { schema: postTranslationAttempt, priority: 1 },
  translate_entry: { schema: postTranslationAttempt, priority: 2 },
  measure_divergence: { schema: postTranslation, priority: DEFAULT_JOB_PRIORITY },
  retranslate_after_report: { schema: z.object({ reportId: id, entryId: id }), priority: DEFAULT_JOB_PRIORITY },
  translate_village: { schema: z.strictObject({ villageId: compactId, lang, sourceHash: hash }), priority: 2 },
  translate_invitation_note: { schema: z.strictObject({ invitationId: z.string().uuid(), lang }), priority: 2 },
  embed_entry: { schema: source, priority: DEFAULT_JOB_PRIORITY },
  [SEND_NOTIFICATION_EMAIL_JOB]: { schema: notice, priority: 0 },
  [SEND_DIGEST_JOB]: { schema: dated, priority: 0 },
  [SEND_MEMBER_DIGEST_JOB]: { schema: dated.extend({ userId: z.string().min(1) }), priority: 0 },
  [SEND_PASSKEY_NOTICE_JOB]: {
    schema: z.object({ userId: z.string(), action: z.enum(["added", "removed", "recovery"]), name: z.string(), at: z.string().datetime() }),
    priority: 0,
  },
  cleanup_jobs: { schema: dated, priority: DEFAULT_JOB_PRIORITY },
  rebuild_render_cache: { schema: z.object({ version: z.number().int() }), priority: 5 },
  retry_failed_translations: { schema: dated, priority: DEFAULT_JOB_PRIORITY },
  translate_chat: { schema: z.strictObject({ messageId: compactId, lang, sourceHash: hash }), priority: DEFAULT_JOB_PRIORITY },
  retranslate_chat_report: { schema: z.strictObject({ reportId: id }), priority: DEFAULT_JOB_PRIORITY },
};

export type JobKind = keyof typeof jobDefinitions;
export type JobPayload<K extends JobKind> = z.output<(typeof jobDefinitions)[K]["schema"]>;
