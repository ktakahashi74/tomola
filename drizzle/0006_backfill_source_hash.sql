-- Custom SQL migration (drizzle-kit generate --custom): data migration only, no schema change.
-- Backfill source_hash for rows created before 0005, using the same expression as sourceHash() in app/lib/source-hash.server.ts:
-- hex SHA-256(UTF-8 title || NUL || UTF-8 body). Treat a missing title as an empty string.
UPDATE "entries"
SET "source_hash" = encode(sha256(convert_to(coalesce("title", ''), 'UTF8') || '\x00'::bytea || convert_to("body", 'UTF8')), 'hex')
WHERE "source_hash" IS NULL;
