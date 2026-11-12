ALTER TABLE "entries" DROP CONSTRAINT "entries_lang_check";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "reading_counts" DROP CONSTRAINT "reading_counts_source_lang_check";--> statement-breakpoint
ALTER TABLE "reading_counts" DROP CONSTRAINT "reading_counts_read_lang_check";--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "lang_code" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "lang_source" text;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_lang_code_check" CHECK ("entries"."lang_code" is null or ("entries"."lang" = 'other' and "entries"."lang_code" ~ '^[a-z]{2,3}$'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_lang_source_check" CHECK ("entries"."lang_source" is null or "entries"."lang_source" in ('explicit', 'detected', 'default', 'checked'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_lang_check" CHECK ("entries"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'response_to_topic', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_added', 'village_removed', 'village_owner_changed', 'chat_mention', 'translation_report_result', 'source_language_mismatch', 'entry_translation_unavailable'));--> statement-breakpoint
ALTER TABLE "reading_counts" ADD CONSTRAINT "reading_counts_source_lang_check" CHECK ("reading_counts"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other'));--> statement-breakpoint
ALTER TABLE "reading_counts" ADD CONSTRAINT "reading_counts_read_lang_check" CHECK ("reading_counts"."read_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other'));