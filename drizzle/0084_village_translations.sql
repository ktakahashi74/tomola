CREATE TABLE "village_translations" (
	"village_id" text NOT NULL,
	"lang" text NOT NULL,
	"name" text,
	"description" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"source_hash" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "village_translations_village_id_lang_pk" PRIMARY KEY("village_id","lang"),
	CONSTRAINT "village_translations_lang_check" CHECK ("village_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "village_translations_state_check" CHECK ("village_translations"."state" in ('pending', 'ready', 'failed')),
	CONSTRAINT "village_translations_hash_check" CHECK ("village_translations"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "village_translations_ready_check" CHECK ("village_translations"."state" <> 'ready' OR "village_translations"."name" IS NOT NULL OR "village_translations"."description" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "villages" ADD COLUMN "source_lang" text;--> statement-breakpoint
ALTER TABLE "village_translations" ADD CONSTRAINT "village_translations_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_source_lang_check" CHECK ("villages"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi'));