DROP INDEX "jobs_due_idx";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
UPDATE "jobs" SET "priority" = CASE
  WHEN "kind" IN ('send_notification_email', 'send_digest', 'send_passkey_notice') THEN 0
  WHEN "kind" = 'translate_title' THEN 1
  ELSE 2 END;--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","priority","run_at","id");
