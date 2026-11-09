CREATE TABLE "ai_draft_edits" (
	"entry_id" bigint PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"before_chars" integer NOT NULL,
	"after_chars" integer NOT NULL,
	"changed_chars" integer NOT NULL,
	"comparison_chars" integer NOT NULL,
	"changed" boolean NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_draft_edits_source" CHECK ("ai_draft_edits"."source" in ('api', 'mcp'))
);
--> statement-breakpoint
CREATE TABLE "quality_metric_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_metric_state_singleton" CHECK ("quality_metric_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "translation_eval_points" (
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"to_lang" text NOT NULL,
	"check_id" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"preserved" boolean NOT NULL,
	"severe" boolean NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "translation_eval_points_run_id_case_id_to_lang_check_id_pk" PRIMARY KEY("run_id","case_id","to_lang","check_id"),
	CONSTRAINT "translation_eval_points_severe_check" CHECK (not "translation_eval_points"."preserved" or not "translation_eval_points"."severe")
);
--> statement-breakpoint
CREATE TABLE "translation_eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"set_version" text NOT NULL,
	"set_hash" text NOT NULL,
	"translator" jsonb NOT NULL,
	"glossary_version" text,
	"glossary" jsonb NOT NULL,
	"judge" jsonb NOT NULL,
	"same_provider" boolean NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd_micro" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "translation_eval_runs_status_check" CHECK ("translation_eval_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "translation_eval_texts" (
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"from_lang" text NOT NULL,
	"to_lang" text NOT NULL,
	"category" text NOT NULL,
	"source" text NOT NULL,
	"translation" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" text,
	CONSTRAINT "translation_eval_texts_run_id_case_id_to_lang_pk" PRIMARY KEY("run_id","case_id","to_lang")
);
--> statement-breakpoint
CREATE TABLE "translation_signal_counts" (
	"scope" text NOT NULL,
	"from_lang" text NOT NULL,
	"to_lang" text NOT NULL,
	"generated" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "translation_signal_counts_scope_from_lang_to_lang_pk" PRIMARY KEY("scope","from_lang","to_lang"),
	CONSTRAINT "translation_signal_counts_scope" CHECK ("translation_signal_counts"."scope" in ('post', 'chat')),
	CONSTRAINT "translation_signal_counts_nonnegative" CHECK ("translation_signal_counts"."generated" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_translation_reports" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "ai_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "ai_source" text;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "translation_reports" ADD COLUMN "source_lang" text;--> statement-breakpoint
ALTER TABLE "ai_draft_edits" ADD CONSTRAINT "ai_draft_edits_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_eval_points" ADD CONSTRAINT "translation_eval_points_run_id_translation_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."translation_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_eval_texts" ADD CONSTRAINT "translation_eval_texts_run_id_translation_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."translation_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_eval_runs_started_idx" ON "translation_eval_runs" USING btree ("started_at");
--> statement-breakpoint
INSERT INTO "quality_metric_state" ("id") VALUES (1);
