-- Make the change timestamp a STORED generated column. Adding it populates existing rows, rewriting the whole table.
-- The expression is the same one previously calculated on each change-feed and manifest query.
ALTER TABLE "entries" ADD COLUMN "changed_at" timestamp with time zone GENERATED ALWAYS AS (greatest(created_at, coalesce(edited_at, created_at), coalesce(deleted_at, created_at), coalesce(moderated_at, created_at))) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "entries_changed_idx" ON "entries" USING btree ("changed_at","id");--> statement-breakpoint
CREATE INDEX "entries_thread_root_idx" ON "entries" USING btree (coalesce("thread_id", "id"));