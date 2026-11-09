CREATE TABLE "translation_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "translation_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
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
	"fallback" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "translation_revisions_reason_check" CHECK ("translation_revisions"."reason" in ('retranslate', 'author_translation', 'human_edit', 'author_deleted'))
);
--> statement-breakpoint
ALTER TABLE "translations" ADD COLUMN "fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "translation_revisions" ADD CONSTRAINT "translation_revisions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_revisions_entry_idx" ON "translation_revisions" USING btree ("entry_id","lang","field","kind");