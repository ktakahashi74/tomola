-- Data backfill (custom migration): calculate entries.reply_count and entries.last_activity_at, added in 0013, for existing topics.
-- reply_count counts undeleted replies; last_activity_at is the maximum created_at of the topic and its undeleted replies.
-- Replies do not use these columns; set their last_activity_at to their own created_at rather than leaving the default migration time.
UPDATE "entries" AS t
SET "reply_count" = s."reply_count",
    "last_activity_at" = GREATEST(t."created_at", s."last_reply_at")
FROM (
  SELECT "thread_id", count(*)::integer AS "reply_count", max("created_at") AS "last_reply_at"
  FROM "entries"
  WHERE "kind" = 'reply' AND "deleted_at" IS NULL AND "thread_id" IS NOT NULL
  GROUP BY "thread_id"
) AS s
WHERE t."id" = s."thread_id" AND t."kind" = 'topic';--> statement-breakpoint
UPDATE "entries" SET "last_activity_at" = "created_at" WHERE "reply_count" = 0;
