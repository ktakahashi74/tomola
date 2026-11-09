CREATE TABLE "saved_topics" (
	"user_id" text NOT NULL,
	"topic_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_topics_user_id_topic_id_pk" PRIMARY KEY("user_id","topic_id")
);
--> statement-breakpoint
ALTER TABLE "saved_topics" ADD CONSTRAINT "saved_topics_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_topics" ADD CONSTRAINT "saved_topics_topic_id_entries_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_topics_member_order_idx" ON "saved_topics" USING btree ("user_id","created_at" DESC NULLS LAST,"topic_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "saved_topics_topic_idx" ON "saved_topics" USING btree ("topic_id");