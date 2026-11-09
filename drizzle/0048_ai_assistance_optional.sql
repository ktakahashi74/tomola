ALTER TABLE "drafts" ALTER COLUMN "ai_assistance" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "drafts" ALTER COLUMN "ai_assistance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ALTER COLUMN "ai_assistance" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entries" ALTER COLUMN "ai_assistance" DROP NOT NULL;--> statement-breakpoint
-- Until now the screens always sent a value, and 'none' was the default: a 'none' on a row written on screen (via = 'web') cannot be told from a choice,
-- so it becomes "not stated" (NULL). Rows with via = 'api' keep their value: through the API the author wrote it in the frontmatter or the API filled in the default,
-- and the two cannot be told apart either, so these are left as they were. Values other than 'none' stay everywhere.
UPDATE "entries" SET "ai_assistance" = NULL WHERE "ai_assistance" = 'none' AND "via" = 'web';--> statement-breakpoint
UPDATE "drafts" SET "ai_assistance" = NULL WHERE "ai_assistance" = 'none' AND "via" = 'web';
