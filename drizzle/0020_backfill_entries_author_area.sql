-- Data backfill (custom migration): populate entries.author_area, added in 0019, with the author's language area at posting for existing posts.
-- The historical area was not stored, so use the author's current area. Before this migration there was no way to change areas; the current and posting-time areas are therefore the same.
-- Leave posts whose author has no profile at null.
UPDATE "entries" AS e
SET "author_area" = p."home_area"
FROM "profiles" AS p
WHERE p."user_id" = e."author_id" AND e."author_area" IS NULL;
