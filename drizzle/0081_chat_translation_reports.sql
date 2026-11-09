CREATE TABLE "chat_translation_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_translation_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"reporter_id" text,
	"lang" text NOT NULL,
	"source_lang" text NOT NULL,
	"source_hash" text NOT NULL,
	"translation_hash" text NOT NULL,
	"original" text,
	"translation" text,
	"note" text,
	"created_seq" bigint NOT NULL,
	"changed_seq" bigint NOT NULL,
	"status" text NOT NULL,
	"retry_attempted_at" timestamp with time zone,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pruned_at" timestamp with time zone,
	CONSTRAINT "chat_translation_reports_lang_check" CHECK ("chat_translation_reports"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "chat_translation_reports_source_lang_check" CHECK ("chat_translation_reports"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "chat_translation_reports_status_check" CHECK ("chat_translation_reports"."status" in ('retry', 'open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "chat_access_log" DROP CONSTRAINT "chat_access_log_case_check";--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD COLUMN "translation_report_id" bigint;--> statement-breakpoint
ALTER TABLE "chat_translation_reports" ADD CONSTRAINT "chat_translation_reports_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_translation_reports" ADD CONSTRAINT "chat_translation_reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_translation_reports" ADD CONSTRAINT "chat_translation_reports_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_translation_reports_reporter_unique" ON "chat_translation_reports" USING btree ("message_id","lang","reporter_id","translation_hash");--> statement-breakpoint
CREATE INDEX "chat_translation_reports_target_idx" ON "chat_translation_reports" USING btree ("message_id","lang");--> statement-breakpoint
CREATE INDEX "chat_translation_reports_queue_idx" ON "chat_translation_reports" USING btree ("status","lang","created_at");--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_translation_report_id_chat_translation_reports_id_fk" FOREIGN KEY ("translation_report_id") REFERENCES "public"."chat_translation_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_case_check" CHECK (("chat_access_log"."report_id" IS NOT NULL)::int + ("chat_access_log"."appeal_id" IS NOT NULL)::int + ("chat_access_log"."translation_report_id" IS NOT NULL)::int = 1);