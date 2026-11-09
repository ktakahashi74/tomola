CREATE TABLE "village_departures" (
	"village_id" text NOT NULL,
	"user_id" text NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "village_departures_village_id_user_id_pk" PRIMARY KEY("village_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "village_departures" ADD CONSTRAINT "village_departures_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_departures" ADD CONSTRAINT "village_departures_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "village_events_add_member_actor_idx" ON "village_events" USING btree ("actor_id","created_at") WHERE "village_events"."action" = 'add_member';--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_added', 'village_removed', 'village_owner_changed', 'chat_mention'));