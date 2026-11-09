-- Questions that ask for stances, reply tags and alternative framings, before stances themselves.
-- changed_at is generated (0039). Add meta_changed_at to its expression with one SET EXPRESSION statement, rather than drizzle-kit's drop-and-add pair:
-- dropping and adding would reference meta_changed_at before it exists and rewrite the table twice. PostgreSQL 17+ and PGlite 0.5.8 accept SET EXPRESSION.
-- Existing changed_at values stay the same because meta_changed_at is null. The table is rewritten once.
ALTER TABLE "drafts" ADD COLUMN "asks_stance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "alt_of" bigint;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "stance_tag" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "asks_stance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "alt_of" bigint;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "stance_tag" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "stance_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "meta_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entries" ALTER COLUMN "changed_at" SET EXPRESSION AS (greatest(created_at, coalesce(edited_at, created_at), coalesce(deleted_at, created_at), coalesce(moderated_at, created_at), coalesce(meta_changed_at, created_at)));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_alt_of_entries_id_fk" FOREIGN KEY ("alt_of") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_alt_of_entries_id_fk" FOREIGN KEY ("alt_of") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_alt_of_idx" ON "entries" USING btree ("alt_of","created_at" DESC NULLS FIRST) WHERE "entries"."alt_of" is not null;--> statement-breakpoint
CREATE INDEX "entries_thread_stance_tag_idx" ON "entries" USING btree ("thread_id","stance_tag") WHERE "entries"."stance_tag" is not null;--> statement-breakpoint
CREATE INDEX "entries_question_activity_idx" ON "entries" USING btree ("last_activity_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "entries"."kind" = 'topic' and "entries"."deleted_at" is null and "entries"."asks_stance";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_asks_stance_kind_check" CHECK (not "drafts"."asks_stance" or "drafts"."kind" = 'topic');--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_alt_of_check" CHECK ("drafts"."alt_of" is null or ("drafts"."asks_stance" and "drafts"."kind" = 'topic'));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_stance_tag_check" CHECK ("drafts"."stance_tag" is null or ("drafts"."kind" = 'reply' and "drafts"."stance_tag" in ('agree', 'disagree', 'neither', 'objection')));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_asks_stance_kind_check" CHECK (not "entries"."asks_stance" or "entries"."kind" = 'topic');--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_alt_of_check" CHECK ("entries"."alt_of" is null or ("entries"."asks_stance" and "entries"."alt_of" <> "entries"."id"));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_stance_tag_check" CHECK ("entries"."stance_tag" is null or ("entries"."kind" = 'reply' and "entries"."stance_tag" in ('agree', 'disagree', 'neither', 'objection')));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_stance_locked_check" CHECK ("entries"."stance_locked_at" is null or "entries"."asks_stance");
