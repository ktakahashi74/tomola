CREATE TABLE "glossary_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "glossary_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"editor_id" text,
	"via" text DEFAULT 'admin' NOT NULL,
	"proposal_entry_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glossary_revisions_change_check" CHECK ("glossary_revisions"."before" is not null or "glossary_revisions"."after" is not null),
	CONSTRAINT "glossary_revisions_via_check" CHECK ("glossary_revisions"."via" in ('admin', 'import'))
);
--> statement-breakpoint
ALTER TABLE "glossary_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "glossary_revisions" ADD CONSTRAINT "glossary_revisions_entry_id_glossary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."glossary_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_revisions" ADD CONSTRAINT "glossary_revisions_editor_id_user_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_revisions" ADD CONSTRAINT "glossary_revisions_proposal_entry_id_entries_id_fk" FOREIGN KEY ("proposal_entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glossary_revisions_entry_idx" ON "glossary_revisions" USING btree ("entry_id","id");--> statement-breakpoint
CREATE INDEX "glossary_revisions_editor_idx" ON "glossary_revisions" USING btree ("editor_id");--> statement-breakpoint
CREATE INDEX "glossary_revisions_proposal_idx" ON "glossary_revisions" USING btree ("proposal_entry_id") WHERE "glossary_revisions"."proposal_entry_id" is not null;--> statement-breakpoint
-- ==== Manually added section, not drizzle-kit generate output. When renumbering, copy everything below to the end of the new SQL file. ====
-- Seed one creation revision per existing glossary entry. Use its current updater and timestamp; earlier overwrites are no longer known.
-- via is import if updated_by is absent (imported rows; only human screen edits used to set updated_by), otherwise admin.
INSERT INTO "glossary_revisions" ("entry_id", "before", "after", "editor_id", "via", "created_at")
SELECT "id", NULL,
       jsonb_build_object('term', "term", 'candidates', to_jsonb("candidates"), 'note', "note", 'keepOriginal', "keep_original", 'needsReview', "needs_review"),
       "updated_by",
       CASE WHEN "updated_by" IS NULL THEN 'import' ELSE 'admin' END,
       "updated_at"
FROM "glossary_entries" ORDER BY "id";
