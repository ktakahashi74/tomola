ALTER TABLE "profiles" ALTER COLUMN "home_area_changed_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "home_area_changed_at" DROP NOT NULL;