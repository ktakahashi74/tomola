ALTER TABLE "profiles" ADD COLUMN "residence_country" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "adult_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "trial_consent_version" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "trial_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "stance_consent_version" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "stance_consent_at" timestamp with time zone;