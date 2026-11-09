CREATE TABLE "appeals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appeals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action_id" bigint NOT NULL,
	"appellant_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "appeals_status_check" CHECK ("appeals"."status" in ('open', 'upheld', 'overturned'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "appeal_id" bigint;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_action_id_moderation_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appellant_id_user_id_fk" FOREIGN KEY ("appellant_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_action_appellant_unique" ON "appeals" USING btree ("action_id","appellant_id");--> statement-breakpoint
CREATE INDEX "appeals_open_idx" ON "appeals" USING btree ("created_at","id") WHERE "appeals"."status" = 'open';--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_appeal_id_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeals"("id") ON DELETE set null ON UPDATE no action;