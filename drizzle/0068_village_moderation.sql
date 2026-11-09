CREATE TABLE "village_report_snapshots" (
	"report_id" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	"slug" text,
	"pruned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_action_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_target_check";--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "target_village_id" text;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "village_event_id" bigint;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "village_id" text;--> statement-breakpoint
ALTER TABLE "village_report_snapshots" ADD CONSTRAINT "village_report_snapshots_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_village_id_villages_id_fk" FOREIGN KEY ("target_village_id") REFERENCES "public"."villages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_village_event_id_village_events_id_fk" FOREIGN KEY ("village_event_id") REFERENCES "public"."village_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_village_reporter_open_unique" ON "reports" USING btree ("village_id","reporter_id") WHERE "reports"."status" = 'open' AND "reports"."village_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_fix_village_event_check" CHECK ("moderation_actions"."action" <> 'fix_village' or "moderation_actions"."village_event_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('hide', 'unhide', 'suspend', 'unsuspend', 'dismiss_report', 'delete', 'restore', 'exclude_reactions', 'include_reactions', 'fix_entry', 'unfix_entry', 'fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_check" CHECK ((("moderation_actions"."action" in ('hide', 'unhide', 'delete', 'restore', 'dismiss_report', 'fix_entry', 'unfix_entry') and "moderation_actions"."target_entry_id" is not null) or ("moderation_actions"."action" in ('suspend', 'unsuspend', 'exclude_reactions', 'include_reactions') and "moderation_actions"."target_user_id" is not null)) and "moderation_actions"."target_village_id" is null or ("moderation_actions"."action" in ('fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report') and "moderation_actions"."target_village_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null));--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_check" CHECK (("reports"."entry_id" IS NOT NULL)::int + ("reports"."village_id" IS NOT NULL)::int = 1);