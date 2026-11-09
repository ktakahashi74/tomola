ALTER TABLE "profiles" ADD COLUMN "email_pref" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "ui_locale" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_email_pref_check" CHECK ("profiles"."email_pref" in ('immediate', 'daily', 'none'));