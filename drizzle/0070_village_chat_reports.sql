CREATE TABLE "chat_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"reader_id" text,
	"reader_handle" text NOT NULL,
	"report_id" bigint,
	"appeal_id" bigint,
	"village_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"ranges" jsonb NOT NULL,
	"versions" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_access_log_case_check" CHECK (("chat_access_log"."report_id" IS NOT NULL)::int + ("chat_access_log"."appeal_id" IS NOT NULL)::int = 1),
	CONSTRAINT "chat_access_log_kind_check" CHECK ("chat_access_log"."kind" in ('snapshot', 'context')),
	CONSTRAINT "chat_access_log_range_check" CHECK ("chat_access_log"."from_seq" >= 0 AND "chat_access_log"."to_seq" >= "chat_access_log"."from_seq")
);
--> statement-breakpoint
CREATE TABLE "chat_report_snapshots" (
	"message_id" text PRIMARY KEY NOT NULL,
	"body" text,
	"lang" text NOT NULL,
	"author_id" text,
	"author_handle" text NOT NULL,
	"message_created_at" timestamp with time zone NOT NULL,
	"created_seq" bigint NOT NULL,
	"changed_seq" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pruned_at" timestamp with time zone,
	CONSTRAINT "chat_report_snapshots_lang_check" CHECK ("chat_report_snapshots"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi'))
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_action_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_target_check";--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "target_chat_message_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "chat_message_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "chat_lang" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "chat_author_id" text;--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_reader_id_user_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_appeal_id_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_report_snapshots" ADD CONSTRAINT "chat_report_snapshots_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_report_snapshots" ADD CONSTRAINT "chat_report_snapshots_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_access_log_created_idx" ON "chat_access_log" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_access_log_report_idx" ON "chat_access_log" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "chat_access_log_appeal_idx" ON "chat_access_log" USING btree ("appeal_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("target_chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_chat_author_id_user_id_fk" FOREIGN KEY ("chat_author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_chat_idx" ON "moderation_actions" USING btree ("target_chat_message_id","id" DESC NULLS LAST) WHERE "moderation_actions"."target_chat_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_chat_reporter_unique" ON "reports" USING btree ("chat_message_id","reporter_id") WHERE "reports"."chat_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "village_events_village_idx" ON "village_events" USING btree ("village_id","id");--> statement-breakpoint
CREATE INDEX "village_events_old_slug_idx" ON "village_events" USING btree (("detail"->>'oldSlug'),"created_at") WHERE "village_events"."action" = 'moderation_fix' AND "village_events"."detail"->>'oldSlug' <> "village_events"."detail"->>'slug';--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('hide', 'unhide', 'suspend', 'unsuspend', 'dismiss_report', 'delete', 'restore', 'exclude_reactions', 'include_reactions', 'fix_entry', 'unfix_entry', 'fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report', 'hide_chat', 'unhide_chat', 'dismiss_chat_report'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_check" CHECK (((("moderation_actions"."action" in ('hide', 'unhide', 'delete', 'restore', 'dismiss_report', 'fix_entry', 'unfix_entry') and "moderation_actions"."target_entry_id" is not null) or ("moderation_actions"."action" in ('suspend', 'unsuspend', 'exclude_reactions', 'include_reactions') and "moderation_actions"."target_user_id" is not null)) and "moderation_actions"."target_village_id" is null and "moderation_actions"."target_chat_message_id" is null) or ("moderation_actions"."action" in ('fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report') and "moderation_actions"."target_village_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_chat_message_id" is null) or ("moderation_actions"."action" in ('hide_chat', 'unhide_chat', 'dismiss_chat_report') and "moderation_actions"."target_chat_message_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_village_id" is null));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_chat_lang_check" CHECK (("reports"."chat_message_id" IS NULL AND "reports"."chat_lang" IS NULL AND "reports"."chat_author_id" IS NULL) OR ("reports"."chat_message_id" IS NOT NULL AND "reports"."chat_lang" IS NOT NULL AND "reports"."chat_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."entry_id" IS NOT NULL)::int + ("reports"."village_id" IS NOT NULL)::int + ("reports"."chat_message_id" IS NOT NULL)::int = 1);