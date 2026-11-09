SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE entries, votes, profiles, topic_listing_stats IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "topic_listing_stats" ADD COLUMN "asks_stance" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE topic_listing_stats s SET asks_stance = e.asks_stance FROM entries e WHERE e.id = s.topic_id;
--> statement-breakpoint
CREATE INDEX "topic_listing_question_activity_idx" ON "topic_listing_stats" USING btree ("last_activity_at" DESC NULLS LAST,"topic_id" DESC NULLS LAST) WHERE "topic_listing_stats"."asks_stance" = true;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_topic_listing_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'topic' THEN
    INSERT INTO topic_listing_stats (topic_id, lang, village_id, created_at, last_activity_at, asks_stance)
    VALUES (NEW.id, NEW.lang, NEW.village_id, NEW.created_at, NEW.last_activity_at, NEW.asks_stance)
    ON CONFLICT (topic_id) DO UPDATE SET lang = EXCLUDED.lang, village_id = EXCLUDED.village_id,
      created_at = EXCLUDED.created_at, last_activity_at = EXCLUDED.last_activity_at, asks_stance = EXCLUDED.asks_stance
    WHERE ROW(topic_listing_stats.lang, topic_listing_stats.village_id, topic_listing_stats.created_at, topic_listing_stats.last_activity_at, topic_listing_stats.asks_stance)
      IS DISTINCT FROM ROW(EXCLUDED.lang, EXCLUDED.village_id, EXCLUDED.created_at, EXCLUDED.last_activity_at, EXCLUDED.asks_stance);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER entries_listing_activity ON entries;
--> statement-breakpoint
CREATE TRIGGER entries_listing_activity AFTER UPDATE OF lang, village_id, created_at, last_activity_at, asks_stance ON entries
FOR EACH ROW EXECUTE FUNCTION sync_topic_listing_activity();
--> statement-breakpoint
-- Eligibility changes and votes share a member-specific transaction lock.
-- It does not conflict with a posting transaction's profile row lock.
CREATE OR REPLACE FUNCTION sync_profile_listing_counts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_id text;
  target_id bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.reactions_excluded_at IS NOT DISTINCT FROM OLD.reactions_excluded_at THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN member_id := OLD.user_id; ELSE member_id := NEW.user_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tomola:topic-listing-voter:' || member_id, 0));
  FOR target_id IN SELECT s.topic_id FROM topic_listing_stats s
    JOIN votes v ON v.entry_id = s.topic_id WHERE v.voter_id = member_id ORDER BY s.topic_id
  LOOP
    PERFORM refresh_topic_insightful(target_id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER votes_listing_count ON votes;
--> statement-breakpoint
-- Transition rows include all votes removed by a foreign-key cascade. Lock
-- each affected member, then each affected topic, in a stable order.
CREATE OR REPLACE FUNCTION sync_vote_listing_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_id text;
  target_id bigint;
BEGIN
  FOR member_id IN SELECT DISTINCT voter_id FROM changed_votes ORDER BY voter_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('tomola:topic-listing-voter:' || member_id, 0));
  END LOOP;
  FOR target_id IN SELECT DISTINCT entry_id FROM changed_votes ORDER BY entry_id
  LOOP
    PERFORM refresh_topic_insightful(target_id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER votes_listing_insert AFTER INSERT ON votes REFERENCING NEW TABLE AS changed_votes
FOR EACH STATEMENT EXECUTE FUNCTION sync_vote_listing_count();
--> statement-breakpoint
CREATE TRIGGER votes_listing_delete AFTER DELETE ON votes REFERENCING OLD TABLE AS changed_votes
FOR EACH STATEMENT EXECUTE FUNCTION sync_vote_listing_count();
