CREATE TABLE "village_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "village_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"village_id" text NOT NULL,
	"actor_id" text,
	"actor_handle" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "village_invites" (
	"id" text PRIMARY KEY DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"village_id" text NOT NULL,
	"user_id" text NOT NULL,
	"invited_by" text,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"response_event_id" bigint,
	CONSTRAINT "village_invites_kind_check" CHECK ("village_invites"."kind" in ('join', 'owner')),
	CONSTRAINT "village_invites_state_check" CHECK ("village_invites"."state" in ('pending', 'accepted', 'declined', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "villages" DROP CONSTRAINT "villages_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "village_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "village_invite_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "village_reason" text;--> statement-breakpoint
ALTER TABLE "village_events" ADD CONSTRAINT "village_events_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_events" ADD CONSTRAINT "village_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_invites" ADD CONSTRAINT "village_invites_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_invites" ADD CONSTRAINT "village_invites_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_invites" ADD CONSTRAINT "village_invites_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_invites" ADD CONSTRAINT "village_invites_response_event_id_village_events_id_fk" FOREIGN KEY ("response_event_id") REFERENCES "public"."village_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "village_invites_pending_unique" ON "village_invites" USING btree ("village_id","user_id","kind") WHERE "village_invites"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "village_invites_recipient_idx" ON "village_invites" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "village_invites_pair_idx" ON "village_invites" USING btree ("invited_by","user_id","response_event_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_village_invite_id_village_invites_id_fk" FOREIGN KEY ("village_invite_id") REFERENCES "public"."village_invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_removed'));