CREATE TABLE "divergences" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "divergences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"segment_idx" integer NOT NULL,
	"severity" text NOT NULL,
	"note" text NOT NULL,
	"judge_engine" text,
	"judge_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "glossary_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"term" text NOT NULL,
	"lang" text NOT NULL,
	"target_lang" text NOT NULL,
	"candidates" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"keep_original" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"entry_id" bigint NOT NULL,
	"idx" integer NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	CONSTRAINT "segments_entry_id_idx_pk" PRIMARY KEY("entry_id","idx")
);
--> statement-breakpoint
CREATE TABLE "translation_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "translation_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"field" text NOT NULL,
	"reporter_id" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "translations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"field" text NOT NULL,
	"lang" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"engine" text,
	"model" text,
	"prompt_version" text,
	"glossary_version" text,
	"source_hash" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"html" text,
	"html_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "display_lang" text;--> statement-breakpoint
ALTER TABLE "divergences" ADD CONSTRAINT "divergences_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_entries" ADD CONSTRAINT "glossary_entries_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD CONSTRAINT "translation_reports_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "divergences_entry_idx" ON "divergences" USING btree ("entry_id","lang");--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_entries_term_idx" ON "glossary_entries" USING btree ("term","lang","target_lang");--> statement-breakpoint
CREATE INDEX "translation_reports_status_idx" ON "translation_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_entry_field_lang_kind_idx" ON "translations" USING btree ("entry_id","field","lang","kind");