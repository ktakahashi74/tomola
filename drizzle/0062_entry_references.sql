CREATE TABLE "entry_references" (
	"source_entry_id" bigint NOT NULL,
	"target_entry_id" bigint NOT NULL,
	CONSTRAINT "entry_references_source_entry_id_target_entry_id_pk" PRIMARY KEY("source_entry_id","target_entry_id")
);
--> statement-breakpoint
ALTER TABLE "entry_references" ADD CONSTRAINT "entry_references_source_entry_id_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_references" ADD CONSTRAINT "entry_references_target_entry_id_entries_id_fk" FOREIGN KEY ("target_entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_references_target_idx" ON "entry_references" USING btree ("target_entry_id");