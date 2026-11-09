CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"village_id" text NOT NULL,
	"author_id" text NOT NULL,
	"lang" text NOT NULL,
	"body" text NOT NULL,
	"created_seq" bigint NOT NULL,
	"changed_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "chat_messages_id_check" CHECK ("chat_messages"."id" ~ '^[a-f0-9]{32}$'),
	CONSTRAINT "chat_messages_lang_check" CHECK ("chat_messages"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "chat_messages_seq_check" CHECK ("chat_messages"."created_seq" > 0 AND "chat_messages"."changed_seq" >= "chat_messages"."created_seq")
);
--> statement-breakpoint
CREATE TABLE "chat_reads" (
	"village_id" text NOT NULL,
	"user_id" text NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_reads_village_id_user_id_pk" PRIMARY KEY("village_id","user_id"),
	CONSTRAINT "chat_reads_seq_check" CHECK ("chat_reads"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_sequences" (
	"village_id" text PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_sequences_seq_check" CHECK ("chat_sequences"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sequences" ADD CONSTRAINT "chat_sequences_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_created_idx" ON "chat_messages" USING btree ("village_id","created_seq");--> statement-breakpoint
CREATE INDEX "chat_messages_changed_idx" ON "chat_messages" USING btree ("village_id","changed_seq");