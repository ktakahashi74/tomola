-- Message references are checked at commit so mention and email writes precede sequence allocation.
CREATE TABLE "chat_mentions" (
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"public_id" text NOT NULL,
	"tokens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "chat_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "chat_message_id" text;--> statement-breakpoint
ALTER TABLE "chat_mentions" ADD CONSTRAINT "chat_mentions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "chat_mentions" ADD CONSTRAINT "chat_mentions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_deleted_body_check" CHECK ("chat_messages"."deleted_at" IS NULL OR "chat_messages"."body" = '');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_removed', 'chat_mention'));--> statement-breakpoint
CREATE INDEX "notifications_chat_message_idx" ON "notifications" USING btree ("chat_message_id") WHERE "notifications"."chat_message_id" is not null;
