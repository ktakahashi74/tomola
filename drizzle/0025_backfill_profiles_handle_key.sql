-- Data backfill (custom migration): populate profiles.handle_key, added in 0024, by applying NFKC, lowercasing, then NFKC again to the handle
-- (handleKey in app/lib/handles.ts), and add NOT NULL and the unique index defined in schema.ts.
-- PostgreSQL normalize and lower produce the same result as the app's handleKey (per-character lowercasing, including final sigma and U+0130),
-- as tests/handles.test.ts checks across multiple strings.
-- If existing handles differ only in case or character width, the unique index cannot be created. Fail with the conflicting names; rename one manually and rerun.
UPDATE "profiles" SET "handle_key" = normalize(lower(normalize("handle", NFKC)), NFKC) WHERE "handle_key" IS NULL;--> statement-breakpoint
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg('"' || "handle" || '"', ', ' ORDER BY "handle") INTO dup
  FROM "profiles"
  WHERE "handle_key" IN (SELECT "handle_key" FROM "profiles" GROUP BY "handle_key" HAVING count(*) > 1);
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'handle_key collision: these display names are the same after NFKC normalization and lowercasing: %. Rename all but one of them (UPDATE profiles SET handle = ''<new name>'' WHERE handle = ''<old name>'') and run the migration again.', dup;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "handle_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_handle_key_unique" ON "profiles" USING btree ("handle_key");
