CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_severity_check" CHECK ("divergences"."severity" in ('low', 'medium', 'high'));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_check" CHECK ("drafts"."kind" in ('topic', 'reply'));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_via_check" CHECK ("drafts"."via" in ('web', 'api'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_kind_check" CHECK ("entries"."kind" in ('topic', 'reply'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_lang_check" CHECK ("entries"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_ai_assistance_check" CHECK ("entries"."ai_assistance" in ('none', 'polish', 'draft', 'coauthor'));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_via_check" CHECK ("entries"."via" in ('web', 'api'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_purpose_check" CHECK ("llm_usage"."purpose" in ('translate', 'judge', 'embed'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_home_area_check" CHECK ("profiles"."home_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other'));--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_status_check" CHECK ("translation_reports"."status" in ('open', 'resolved'));--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_field_check" CHECK ("translations"."field" in ('title', 'body'));--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_lang_check" CHECK ("translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi'));--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_kind_check" CHECK ("translations"."kind" in ('primary', 'secondary', 'author', 'human'));