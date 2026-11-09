ALTER TABLE "votes" DROP CONSTRAINT "votes_entry_id_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "votes_voter_idx" ON "votes" USING btree ("voter_id");