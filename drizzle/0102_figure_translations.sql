CREATE TABLE "figure_media" (
	"media_id" text NOT NULL,
	"reading_key" text NOT NULL,
	CONSTRAINT "figure_media_media_id_reading_key_pk" PRIMARY KEY("media_id","reading_key")
);
--> statement-breakpoint
CREATE TABLE "figure_readings" (
	"key" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reading" jsonb,
	"engine" text,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "figure_readings_key_check" CHECK ("figure_readings"."key" ~ '^[a-f0-9]{64}:v[1-9][0-9]{0,5}$'),
	CONSTRAINT "figure_readings_version_check" CHECK ("figure_readings"."version" between 1 and 999999 and "figure_readings"."key" like '%:v' || "figure_readings"."version"::text),
	CONSTRAINT "figure_readings_state_check" CHECK ("figure_readings"."state" in ('pending', 'ready', 'skipped')),
	CONSTRAINT "figure_readings_ready_check" CHECK ("figure_readings"."state" <> 'ready' or "figure_readings"."reading" is not null)
);
--> statement-breakpoint
CREATE TABLE "figure_translations" (
	"media_id" text NOT NULL,
	"reading_key" text NOT NULL,
	"lang" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"bytes" "bytea",
	"labels" jsonb,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "figure_translations_media_id_reading_key_lang_pk" PRIMARY KEY("media_id","reading_key","lang"),
	CONSTRAINT "figure_translations_lang_check" CHECK ("figure_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "figure_translations_state_check" CHECK ("figure_translations"."state" in ('ready', 'skipped')),
	CONSTRAINT "figure_translations_content_check" CHECK (("figure_translations"."state" = 'ready' and "figure_translations"."bytes" is not null and octet_length("figure_translations"."bytes") between 1 and 2097152 and "figure_translations"."labels" is not null) or ("figure_translations"."state" = 'skipped' and "figure_translations"."bytes" is null and "figure_translations"."labels" is null))
);
--> statement-breakpoint
ALTER TABLE "figure_media" ADD CONSTRAINT "figure_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figure_media" ADD CONSTRAINT "figure_media_reading_key_figure_readings_key_fk" FOREIGN KEY ("reading_key") REFERENCES "public"."figure_readings"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figure_translations" ADD CONSTRAINT "figure_translations_source_fk" FOREIGN KEY ("media_id","reading_key") REFERENCES "public"."figure_media"("media_id","reading_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "figure_media_reading_idx" ON "figure_media" USING btree ("reading_key");
--> statement-breakpoint
-- Remove derived bytes and text for every original-image withdrawal, including
-- account deletion and operator scripts. Lock ordering matches admission.
CREATE FUNCTION remove_media_figures() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_key text;
BEGIN
  PERFORM pg_advisory_xact_lock(732108, 1);
  FOR source_key IN SELECT reading_key FROM figure_media WHERE media_id = OLD.id ORDER BY reading_key LOOP
    DELETE FROM figure_media WHERE media_id = OLD.id AND reading_key = source_key;
    UPDATE jobs SET status = 'done', locked_at = NULL,
      payload = '{"discardPaidTranslationCalls":true}'::jsonb, updated_at = now()
      WHERE kind = 'translate_figure' AND payload->>'mediaId' = OLD.id;
    IF NOT EXISTS (SELECT 1 FROM figure_media WHERE reading_key = source_key) THEN
      DELETE FROM figure_readings WHERE key = source_key;
      UPDATE jobs SET status = 'done', locked_at = NULL,
        payload = '{"discardPaidTranslationCalls":true}'::jsonb, updated_at = now()
        WHERE kind = 'read_figure' AND payload->>'key' = source_key;
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER media_figures_withdrawn AFTER UPDATE OF deleted_at ON media
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION remove_media_figures();
--> statement-breakpoint
CREATE TRIGGER media_figures_deleted BEFORE DELETE ON media
  FOR EACH ROW EXECUTE FUNCTION remove_media_figures();
