CREATE TABLE "entry_reading_counts" (
	"entry_id" bigint NOT NULL,
	"day" date NOT NULL,
	"method" text NOT NULL,
	"is_translated" boolean NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "entry_reading_counts_entry_id_day_method_is_translated_pk" PRIMARY KEY("entry_id","day","method","is_translated"),
	CONSTRAINT "entry_reading_counts_method_check" CHECK ("entry_reading_counts"."method" in ('browser', 'markdown', 'api', 'mcp', 'ai_crawler')),
	CONSTRAINT "entry_reading_counts_count_check" CHECK ("entry_reading_counts"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "entry_reading_metric_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_reading_metric_state_singleton" CHECK ("entry_reading_metric_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "entry_reading_counts" ADD CONSTRAINT "entry_reading_counts_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_reading_counts_day_entry_idx" ON "entry_reading_counts" USING btree ("day","entry_id");
--> statement-breakpoint
INSERT INTO "entry_reading_metric_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;
