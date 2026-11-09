-- Remove author translations. Delete their rows and history, remove author from CHECK, and add columns and indexes for the mistranslation-report flow.
-- Before deployment, confirm that deleting the author-translation data is acceptable (docs/deploy.md, "Pre-check for 0042"). Deleted author translations cannot be recovered.
-- Place deletes before rebuilding CHECK: author rows would prevent adding the new constraint.
-- Guard: if author translation rows or history exist, stop without deleting anything unless session setting tomola.allow_author_delete = on records confirmation.
-- In production and staging, inspect the pre-check SELECT results (docs/deploy.md, "Pre-check for 0042"), take a backup, then rerun with PGOPTIONS="-c tomola.allow_author_delete=on".
-- No extra step is needed if no such rows exist.
DO $$
DECLARE
  n_translations bigint;
  n_revisions bigint;
BEGIN
  SELECT count(*) INTO n_translations FROM "translations" WHERE "kind" = 'author';
  SELECT count(*) INTO n_revisions FROM "translation_revisions" WHERE "kind" = 'author' OR "reason" IN ('author_translation', 'author_deleted');
  IF (n_translations > 0 OR n_revisions > 0) AND coalesce(current_setting('tomola.allow_author_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'migration 0042 deletes author translations (% rows in translations, % in translation_revisions) and nothing was changed. Run the pre-check SELECTs in docs/deploy.md ("Pre-check for 0042"), take a backup, then run the migration again with PGOPTIONS="-c tomola.allow_author_delete=on" (PGlite: TOMOLA_ALLOW_AUTHOR_DELETE=1).', n_translations, n_revisions;
  END IF;
END
$$;--> statement-breakpoint
DELETE FROM "translation_revisions" WHERE "kind" = 'author' OR "reason" IN ('author_translation', 'author_deleted');--> statement-breakpoint
DELETE FROM "translations" WHERE "kind" = 'author';--> statement-breakpoint
ALTER TABLE "translation_revisions" DROP CONSTRAINT "translation_revisions_reason_check";--> statement-breakpoint
ALTER TABLE "translations" DROP CONSTRAINT "translations_kind_check";--> statement-breakpoint
ALTER TABLE "translation_reports" ADD COLUMN "route" text DEFAULT 'moderator' NOT NULL;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD COLUMN "retry_slot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "translation_reports_retry_once_idx" ON "translation_reports" USING btree ("entry_id","lang","source_hash") WHERE "translation_reports"."retry_slot";--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_route_check" CHECK ("translation_reports"."route" in ('retry', 'moderator'));--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_retry_hash_check" CHECK ("translation_reports"."route" <> 'retry' OR "translation_reports"."source_hash" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_retry_slot_check" CHECK (NOT "translation_reports"."retry_slot" OR "translation_reports"."source_hash" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "translation_revisions" ADD CONSTRAINT "translation_revisions_reason_check" CHECK ("translation_revisions"."reason" in ('retranslate', 'human_edit', 'report_retry'));--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_kind_check" CHECK ("translations"."kind" in ('primary', 'secondary', 'human'));--> statement-breakpoint
ALTER TABLE "glossary_entries" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT "llm_usage_purpose_check";--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_purpose_check" CHECK ("llm_usage"."purpose" in ('translate', 'retry', 'judge', 'embed'));--> statement-breakpoint
ALTER TABLE "divergences" ADD COLUMN "category" text DEFAULT 'meaning' NOT NULL;--> statement-breakpoint
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_category_check" CHECK ("divergences"."category" in ('meaning', 'tone'));