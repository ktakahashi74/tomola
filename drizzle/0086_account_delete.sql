CREATE TABLE "account_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	"completion_key" text,
	"user_id" text,
	"confirmation" text,
	"posts" text DEFAULT 'keep' NOT NULL,
	"village_decisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"notice_state" text DEFAULT 'none' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_deletions_completion_key_unique" UNIQUE("completion_key"),
	CONSTRAINT "account_deletions_posts_check" CHECK ("account_deletions"."posts" in ('keep', 'delete')),
	CONSTRAINT "account_deletions_state_check" CHECK ("account_deletions"."state" in ('pending', 'failed', 'completed', 'cancelled')),
	CONSTRAINT "account_deletions_notice_check" CHECK ("account_deletions"."notice_state" in ('none', 'pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "suspended_email_hashes" (
	"hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "appeals" DROP CONSTRAINT "appeals_appellant_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "handle_holds" DROP CONSTRAINT "handle_holds_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "reports" DROP CONSTRAINT "reports_reporter_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "translation_reports" DROP CONSTRAINT "translation_reports_reporter_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "appeals" ALTER COLUMN "appellant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "handle_holds" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "reporter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "translation_reports" ALTER COLUMN "reporter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletions_pending_user_idx" ON "account_deletions" USING btree ("user_id") WHERE "account_deletions"."state" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "suspended_email_hashes_expiry_idx" ON "suspended_email_hashes" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appellant_id_user_id_fk" FOREIGN KEY ("appellant_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_holds" ADD CONSTRAINT "handle_holds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_removed', 'village_owner_changed', 'chat_mention'));