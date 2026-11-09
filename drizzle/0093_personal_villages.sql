ALTER TABLE "villages" DROP CONSTRAINT "villages_kind_check";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "default_village_reset" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "villages" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_owner_id_unique" UNIQUE("owner_id");--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_personal_check" CHECK (("villages"."kind" = 'personal' AND "villages"."owner_id" IS NOT NULL AND "villages"."slug" IS NULL AND "villages"."language" IS NULL AND "villages"."source_lang" IS NULL AND "villages"."name" = '' AND "villages"."description" = '' AND NOT "villages"."system") OR ("villages"."kind" <> 'personal' AND "villages"."owner_id" IS NULL));--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_kind_check" CHECK ("villages"."kind" in ('open', 'closed', 'invite_public', 'personal'));
--> statement-breakpoint
INSERT INTO "villages" ("kind", "owner_id") SELECT 'personal', "user_id" FROM "profiles" ON CONFLICT ("owner_id") DO NOTHING;
