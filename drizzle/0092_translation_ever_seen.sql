ALTER TABLE "translations" ADD COLUMN "ever_seen" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "translations" SET "ever_seen" = true WHERE "first_seen_at" IS NOT NULL;
