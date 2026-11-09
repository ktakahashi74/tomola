CREATE TABLE "entry_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"editor_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_editor_id_user_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_revisions_entry_idx" ON "entry_revisions" USING btree ("entry_id");