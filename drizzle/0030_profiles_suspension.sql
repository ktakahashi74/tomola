ALTER TABLE "profiles" ADD COLUMN "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "suspended_action_id" bigint;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_suspended_action_id_moderation_actions_id_fk" FOREIGN KEY ("suspended_action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_suspended_reason_check" CHECK ("profiles"."suspended_reason" in ('spam', 'harassment', 'infohazard', 'other'));