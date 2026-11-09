DROP INDEX "translation_reports_retry_once_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "translation_reports_retry_once_idx" ON "translation_reports" USING btree ("entry_id", "lang", "field", "source_hash") WHERE "translation_reports"."retry_slot";
