ALTER TABLE "entries" ADD COLUMN "html" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "html_version" integer DEFAULT 0 NOT NULL;