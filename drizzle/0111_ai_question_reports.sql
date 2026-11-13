CREATE TABLE "ai_question_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_question_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"reporter_id" text NOT NULL,
	"topic_id" bigint,
	"village_id" text,
	"question" text NOT NULL,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_question_reports_target_check" CHECK (("ai_question_reports"."topic_id" is not null) <> ("ai_question_reports"."village_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT "llm_usage_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_question_reports" ADD CONSTRAINT "ai_question_reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_question_reports" ADD CONSTRAINT "ai_question_reports_topic_id_entries_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_question_reports" ADD CONSTRAINT "ai_question_reports_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_question_reports_created_idx" ON "ai_question_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_question_reports_reporter_idx" ON "ai_question_reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "ai_question_reports_topic_idx" ON "ai_question_reports" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "ai_question_reports_village_idx" ON "ai_question_reports" USING btree ("village_id");--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_purpose_check" CHECK ("llm_usage"."purpose" in ('translate', 'retry', 'judge', 'embed', 'chat', 'moderation', 'ask', 'ask_village'));