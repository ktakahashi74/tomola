import { createChatNushiHandlers } from "../chat-nushi.server";
import { createNushiTranslationHandlers } from "../nushi-translations.server";
import { createNushiHandlers } from "../nushi.server";
import { createSourceLanguageHandlers } from "./source-language-jobs.server";
import { createPushHandlers } from "./push-jobs.server";
import { createFigureHandlers } from "./figure-jobs.server";
import { createAccountDeletionHandlers } from "./account-delete-jobs.server";
import { createModerationHandlers } from "./moderation-jobs.server";
import { createRenderCacheHandlers } from "~/lib/render-cache.server";
import { createEmbeddingHandlers } from "./embedding-jobs.server";
import { createMaintenanceHandlers } from "./maintenance-jobs.server";
import { createNotificationHandlers } from "./notification-jobs.server";
import { createPasskeyHandlers } from "./passkey-jobs.server";
import { createTranslationHandlers } from "./translation-jobs.server";
import { createVillageTranslationHandlers } from "./village-translation-jobs.server";
import { createInvitationNoteHandlers } from "./invitation-note-jobs.server";
import { createTranslationRecoveryHandlers } from "./translation-recovery.server";
import type { JobHandlers } from "./queue.server";

// translate_village translates the name and description of a village (jobs/village-translation-jobs.server.ts).
// translate_title makes a provisional title before translate_entry refines it using its own body.
// Job-kind/handler registry. Workers claim and run only registered kinds.
// translate_entry (entry × language translation) and measure_divergence (topic disagreement measurement): jobs/translation-jobs.server.ts.
// embed_entry (entry embeddings for semantic search/diversity observations): jobs/embedding-jobs.server.ts.
// send_notification_email (immediate email) and send_digest (daily at UTC 00:00): jobs/notification-jobs.server.ts.
// cleanup_jobs (remove jobs finished over 30 days ago, daily UTC 03:00): jobs/maintenance-jobs.server.ts.
// rebuild_render_cache rebuilds saved body and card HTML at the current version, newest topics first (render-cache.server.ts).
// Handlers throw on failure for retry; throw DeferJob when temporarily unable to run, such as a budget limit.
export const jobHandlers: JobHandlers = { ...createChatNushiHandlers(), ...createNushiHandlers(), ...createNushiTranslationHandlers(), ...createSourceLanguageHandlers(), ...createPushHandlers(), ...createFigureHandlers(), ...createAccountDeletionHandlers(), ...createModerationHandlers(), ...createTranslationHandlers(), ...createVillageTranslationHandlers(), ...createInvitationNoteHandlers(), ...createEmbeddingHandlers(), ...createNotificationHandlers(), ...createPasskeyHandlers(), ...createMaintenanceHandlers(), ...createRenderCacheHandlers(), ...createTranslationRecoveryHandlers() };
