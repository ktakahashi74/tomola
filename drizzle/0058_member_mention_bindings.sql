CREATE TABLE "entry_mention_snapshots" (
	"entry_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"source_hash" text,
	"body" text NOT NULL,
	"bindings" jsonb NOT NULL,
	CONSTRAINT "entry_mention_snapshots_entry_id_revision_pk" PRIMARY KEY("entry_id","revision")
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "mention_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD COLUMN "mention_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "public_id" text DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_mention_snapshots" ADD CONSTRAINT "entry_mention_snapshots_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_public_id_unique" UNIQUE("public_id");
--> statement-breakpoint
-- Give existing source revisions distinct numbers, including a repeated title/body.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY entry_id ORDER BY id) - 1 AS revision
  FROM entry_revisions
)
UPDATE entry_revisions r SET mention_revision = numbered.revision FROM numbered WHERE r.id = numbered.id;
--> statement-breakpoint
UPDATE entries e SET mention_revision = (SELECT count(*) FROM entry_revisions r WHERE r.entry_id = e.id);
