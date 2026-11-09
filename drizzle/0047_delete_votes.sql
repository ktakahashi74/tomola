-- Votes (agreement) become "Insightful" (the reader gained a new perspective). The meaning changes, so the existing rows are deleted instead of being counted.
-- Confirm that deleting agreement votes is acceptable before deploying (docs/deploy.md, "Pre-check for 0047"). The deleted rows do not come back.
-- Guard: on a database that has vote rows, nothing is deleted unless the session setting tomola.allow_vote_delete = on is present.
-- On production and staging, run the pre-check SELECTs in docs/deploy.md ("Pre-check for 0047"), take a backup, then run the migration again with PGOPTIONS="-c tomola.allow_vote_delete=on".
-- (PGlite development data: TOMOLA_ALLOW_VOTE_DELETE=1.) With no rows nothing is needed.
DO $$
DECLARE
  n_votes bigint;
BEGIN
  SELECT count(*) INTO n_votes FROM "votes";
  IF n_votes > 0 AND coalesce(current_setting('tomola.allow_vote_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'migration 0047 deletes the votes, which meant agreement (% rows in votes) and nothing was changed. Run the pre-check SELECTs in docs/deploy.md ("Pre-check for 0047"), take a backup, then run the migration again with PGOPTIONS="-c tomola.allow_vote_delete=on" (PGlite: TOMOLA_ALLOW_VOTE_DELETE=1).', n_votes;
  END IF;
END
$$;--> statement-breakpoint
DELETE FROM "votes";
