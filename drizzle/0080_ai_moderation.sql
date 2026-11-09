ALTER TABLE "llm_usage" DROP CONSTRAINT "llm_usage_purpose_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD COLUMN "reader_kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "ai_priority" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "ai_assessment" jsonb;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "ai_model" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "ai_triaged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_messages_author_created_idx" ON "chat_messages" USING btree ("author_id","created_at","created_seq");--> statement-breakpoint
ALTER TABLE "chat_access_log" ADD CONSTRAINT "chat_access_log_reader_check" CHECK ("chat_access_log"."reader_kind" = 'human' OR ("chat_access_log"."reader_kind" = 'ai' AND "chat_access_log"."reader_id" IS NULL));--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_purpose_check" CHECK ("llm_usage"."purpose" in ('translate', 'retry', 'judge', 'embed', 'chat', 'moderation'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_check" CHECK (("moderation_actions"."automatic" = false AND "moderation_actions"."actor_id" IS NOT NULL) OR ("moderation_actions"."automatic" = true AND "moderation_actions"."actor_id" IS NULL AND "moderation_actions"."action" IN ('hide', 'hide_chat') AND "moderation_actions"."reason" = 'spam'));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_ai_priority_check" CHECK ("reports"."ai_priority" is null or "reports"."ai_priority" in ('urgent', 'normal', 'low'));