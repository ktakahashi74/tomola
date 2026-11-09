CREATE TABLE "moderation_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "moderation_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action" text NOT NULL,
	"target_entry_id" bigint,
	"target_user_id" text,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"actor_id" text NOT NULL,
	"report_id" bigint,
	"until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('hide', 'unhide', 'suspend', 'unsuspend', 'dismiss_report', 'delete', 'restore')),
	CONSTRAINT "moderation_actions_reason_check" CHECK ("moderation_actions"."reason" in ('spam', 'harassment', 'infohazard', 'other')),
	CONSTRAINT "moderation_actions_suspend_until_check" CHECK ("moderation_actions"."action" <> 'suspend' or "moderation_actions"."until" is not null)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"reporter_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	CONSTRAINT "reports_reason_check" CHECK ("reports"."reason" in ('spam', 'harassment', 'infohazard', 'other')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "moderation_action_id" bigint;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_entry_id_entries_id_fk" FOREIGN KEY ("target_entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_created_idx" ON "moderation_actions" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_actions_entry_idx" ON "moderation_actions" USING btree ("target_entry_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_user_idx" ON "moderation_actions" USING btree ("target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_entry_reporter_unique" ON "reports" USING btree ("entry_id","reporter_id");--> statement-breakpoint
CREATE INDEX "reports_open_idx" ON "reports" USING btree ("created_at","id") WHERE "reports"."status" = 'open';--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_moderation_action_id_moderation_actions_id_fk" FOREIGN KEY ("moderation_action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE set null ON UPDATE no action;