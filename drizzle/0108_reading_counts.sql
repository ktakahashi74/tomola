CREATE TABLE "reading_counts" (
	"day" date NOT NULL,
	"method" text NOT NULL,
	"source_lang" text NOT NULL,
	"read_lang" text NOT NULL,
	"source" text NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "reading_counts_day_method_source_lang_read_lang_source_pk" PRIMARY KEY("day","method","source_lang","read_lang","source"),
	CONSTRAINT "reading_counts_method_check" CHECK ("reading_counts"."method" in ('browser', 'markdown', 'api', 'mcp', 'ai_crawler')),
	CONSTRAINT "reading_counts_source_check" CHECK ("reading_counts"."source" in ('share_link', 'search', 'social', 'ai', 'other_site', 'none', 'internal')),
	CONSTRAINT "reading_counts_source_lang_check" CHECK ("reading_counts"."source_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "reading_counts_read_lang_check" CHECK ("reading_counts"."read_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "reading_counts_count_check" CHECK ("reading_counts"."count" >= 0),
	CONSTRAINT "reading_counts_machine_source_check" CHECK ("reading_counts"."method" = 'browser' or "reading_counts"."source" = 'none')
);
--> statement-breakpoint
-- Keep the measurement start even before the first read, without an event,
-- article or reader identifier. This zero bucket contributes no language pair.
INSERT INTO "reading_counts" ("day", "method", "source_lang", "read_lang", "source", "count")
VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 'browser', 'en', 'en', 'none', 0);
