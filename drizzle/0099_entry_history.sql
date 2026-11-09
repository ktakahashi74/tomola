ALTER TABLE "entries" ADD COLUMN "history_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD COLUMN "deleted_at" timestamp with time zone;