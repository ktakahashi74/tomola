SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
UPDATE jobs SET payload = payload - 'paidTranslationCalls' WHERE status = 'done' AND payload ? 'paidTranslationCalls';
--> statement-breakpoint
CREATE TABLE "topic_listing_stats" (
	"topic_id" bigint PRIMARY KEY NOT NULL,
	"lang" text NOT NULL,
	"village_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"insightful_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "topic_listing_count_check" CHECK ("topic_listing_stats"."insightful_count" >= 0)
);
--> statement-breakpoint
DROP INDEX "entries_topic_village_activity_idx";--> statement-breakpoint
DROP INDEX "entries_topic_activity_idx";--> statement-breakpoint
DROP INDEX "entries_topic_lang_activity_idx";--> statement-breakpoint
DROP INDEX "entries_question_activity_idx";--> statement-breakpoint
DROP INDEX "entries_thread_idx";--> statement-breakpoint
DROP INDEX "entries_thread_stance_tag_idx";--> statement-breakpoint
ALTER TABLE "topic_listing_stats" ADD CONSTRAINT "topic_listing_stats_topic_id_entries_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_listing_activity_idx" ON "topic_listing_stats" USING btree ("last_activity_at" DESC NULLS LAST,"topic_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topic_listing_lang_activity_idx" ON "topic_listing_stats" USING btree ("lang","last_activity_at" DESC NULLS LAST,"topic_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topic_listing_village_activity_idx" ON "topic_listing_stats" USING btree ("village_id","last_activity_at" DESC NULLS LAST,"topic_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "topic_listing_insightful_idx" ON "topic_listing_stats" USING btree ("insightful_count" DESC NULLS LAST,"created_at" DESC NULLS LAST,"topic_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_entry_idx" ON "jobs" USING btree (("payload"->>'entryId'),"kind") WHERE "jobs"."status" in ('queued', 'running', 'failed');--> statement-breakpoint
CREATE INDEX "jobs_message_idx" ON "jobs" USING btree (("payload"->>'messageId'),"kind") WHERE "jobs"."status" in ('queued', 'running', 'failed');--> statement-breakpoint
CREATE INDEX "jobs_kind_dedupe_idx" ON "jobs" USING btree ("kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "media_active_bytes_idx" ON "media" USING btree ("uploaded_by","byte_size") WHERE "media"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "reports_handled_group_idx" ON "reports" USING btree ("entry_id","village_id","chat_message_id","created_at","handled_at") WHERE "reports"."status" <> 'open';--> statement-breakpoint
CREATE INDEX "entries_thread_idx" ON "entries" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "entries_thread_stance_tag_idx" ON "entries" USING btree ("thread_id","stance_tag","created_at","id") WHERE "entries"."stance_tag" is not null;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_done_checkpoint_check" CHECK ("jobs"."status" <> 'done' or not ("jobs"."payload" ? 'paidTranslationCalls'));
--> statement-breakpoint
ALTER TABLE entries SET (fillfactor = 80);
--> statement-breakpoint
-- Block concurrent writers while backfilling and installing maintenance.
LOCK TABLE entries, votes, profiles IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO topic_listing_stats (topic_id, lang, village_id, created_at, last_activity_at, insightful_count)
SELECT e.id, e.lang, e.village_id, e.created_at, e.last_activity_at, coalesce(v.total, 0)
FROM entries e LEFT JOIN (
  SELECT v.entry_id, count(*)::integer AS total FROM votes v
  JOIN profiles p ON p.user_id = v.voter_id AND p.reactions_excluded_at IS NULL
  GROUP BY v.entry_id
) v ON v.entry_id = e.id WHERE e.kind = 'topic';
--> statement-breakpoint
CREATE FUNCTION sync_topic_listing_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'topic' THEN
    INSERT INTO topic_listing_stats (topic_id, lang, village_id, created_at, last_activity_at)
    VALUES (NEW.id, NEW.lang, NEW.village_id, NEW.created_at, NEW.last_activity_at)
    ON CONFLICT (topic_id) DO UPDATE SET lang = EXCLUDED.lang, village_id = EXCLUDED.village_id, created_at = EXCLUDED.created_at, last_activity_at = EXCLUDED.last_activity_at
    WHERE topic_listing_stats.lang IS DISTINCT FROM EXCLUDED.lang
       OR topic_listing_stats.village_id IS DISTINCT FROM EXCLUDED.village_id
       OR topic_listing_stats.created_at IS DISTINCT FROM EXCLUDED.created_at
       OR topic_listing_stats.last_activity_at IS DISTINCT FROM EXCLUDED.last_activity_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER entries_listing_insert AFTER INSERT ON entries
FOR EACH ROW EXECUTE FUNCTION sync_topic_listing_activity();
--> statement-breakpoint
CREATE TRIGGER entries_listing_activity AFTER UPDATE OF lang, village_id, created_at, last_activity_at ON entries
FOR EACH ROW EXECUTE FUNCTION sync_topic_listing_activity();
--> statement-breakpoint
-- Lock before counting, in a separate statement, so a waiter recounts using
-- a fresh READ COMMITTED snapshot after the previous updater commits.
CREATE FUNCTION refresh_topic_insightful(target_id bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM topic_listing_stats WHERE topic_id = target_id FOR UPDATE;
  UPDATE topic_listing_stats SET insightful_count = (
    SELECT count(*)::integer FROM votes v JOIN profiles p ON p.user_id = v.voter_id
    WHERE v.entry_id = target_id AND p.reactions_excluded_at IS NULL
  ) WHERE topic_id = target_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION sync_vote_listing_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_id text;
  target_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN member_id := OLD.voter_id; target_id := OLD.entry_id;
  ELSE member_id := NEW.voter_id; target_id := NEW.entry_id;
  END IF;
  -- Exclusion changes lock the profile first too; never count an insertion
  -- against a concurrently changing eligibility decision.
  PERFORM 1 FROM profiles WHERE user_id = member_id FOR SHARE;
  PERFORM refresh_topic_insightful(target_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER votes_listing_count AFTER INSERT OR DELETE ON votes
FOR EACH ROW EXECUTE FUNCTION sync_vote_listing_count();
--> statement-breakpoint
CREATE FUNCTION sync_profile_listing_counts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_id text;
  target_id bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.reactions_excluded_at IS NOT DISTINCT FROM OLD.reactions_excluded_at THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN member_id := OLD.user_id; ELSE member_id := NEW.user_id; END IF;
  -- Multiple affected topics always acquire their rollup locks in ID order.
  FOR target_id IN SELECT s.topic_id FROM topic_listing_stats s
    JOIN votes v ON v.entry_id = s.topic_id WHERE v.voter_id = member_id ORDER BY s.topic_id
  LOOP
    PERFORM refresh_topic_insightful(target_id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER profiles_listing_count AFTER INSERT OR DELETE OR UPDATE OF reactions_excluded_at ON profiles
FOR EACH ROW EXECUTE FUNCTION sync_profile_listing_counts();
