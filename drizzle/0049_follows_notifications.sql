CREATE TABLE "follows" (
	"user_id" text NOT NULL,
	"thread_id" bigint NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id"),
	CONSTRAINT "follows_state_check" CHECK ("follows"."state" in ('following', 'unfollowed'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_email_pref_check";--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "email_pref" SET DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "thread_id" bigint;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "merged_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_thread_id_entries_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follows_thread_following_idx" ON "follows" USING btree ("thread_id") WHERE "follows"."state" = 'following';--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_thread_id_entries_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_followed_unread_unique" ON "notifications" USING btree ("user_id","thread_id") WHERE "notifications"."kind" = 'followed_thread' AND "notifications"."read_at" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_followed_thread_check" CHECK ("notifications"."kind" <> 'followed_thread' OR ("notifications"."thread_id" IS NOT NULL AND "notifications"."entry_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_merged_count_check" CHECK ("notifications"."merged_count" >= 1);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'moderation', 'appeal_decided', 'followed_thread'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_email_pref_check" CHECK ("profiles"."email_pref" in ('auto', 'immediate', 'daily', 'none'));--> statement-breakpoint
-- CUSTOM SQL (not generated; add it again when this migration is regenerated at merge time): a member who kept the old default and a member who chose `daily` cannot be told
-- apart, so every `daily` becomes `auto` (replies are sent soon, everything else stays in the daily digest). `immediate` and `none` stay as they are.
UPDATE "profiles" SET "email_pref" = 'auto' WHERE "email_pref" = 'daily';
