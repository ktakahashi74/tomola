ALTER TABLE "translations" ADD COLUMN "mention_revision" integer;
--> statement-breakpoint
-- Existing translations are assigned to the source revision identified by their hash.
UPDATE translations t SET mention_revision = CASE
  WHEN t.source_hash IS NOT DISTINCT FROM e.source_hash THEN e.mention_revision
  ELSE (SELECT max(r.mention_revision) FROM entry_revisions r WHERE r.entry_id = e.id
    AND encode(sha256(convert_to(coalesce(r.title, ''), 'UTF8') || '\x00'::bytea || convert_to(r.body, 'UTF8')), 'hex') = t.source_hash)
END FROM entries e WHERE t.entry_id = e.id;
