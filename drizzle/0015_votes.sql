CREATE TABLE "votes" (
	"entry_id" bigint NOT NULL,
	"voter_id" text NOT NULL,
	"voter_area" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_entry_id_voter_id_pk" PRIMARY KEY("entry_id","voter_id"),
	CONSTRAINT "votes_voter_area_check" CHECK ("votes"."voter_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other'))
);
--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_user_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_parent_idx" ON "entries" USING btree ("parent_id");