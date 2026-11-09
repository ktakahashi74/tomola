CREATE TABLE "reason_selections" (
	"question_id" bigint NOT NULL,
	"day" text NOT NULL,
	"pick" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reason_selections_question_id_day_pk" PRIMARY KEY("question_id","day"),
	CONSTRAINT "reason_selections_day_check" CHECK ("reason_selections"."day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "reason_selections" ADD CONSTRAINT "reason_selections_question_id_entries_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;