CREATE TABLE "chat_message_translations" (
	"message_id" text NOT NULL,
	"lang" text NOT NULL,
	"text" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"source_hash" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_translations_message_id_lang_pk" PRIMARY KEY("message_id","lang"),
	CONSTRAINT "chat_message_translations_lang_check" CHECK ("chat_message_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "chat_message_translations_state_check" CHECK ("chat_message_translations"."state" in ('pending', 'ready', 'failed', 'paused')),
	CONSTRAINT "chat_message_translations_hash_check" CHECK ("chat_message_translations"."source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_message_translations_ready_check" CHECK ("chat_message_translations"."state" <> 'ready' OR "chat_message_translations"."text" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "llm_usage" DROP CONSTRAINT "llm_usage_purpose_check";--> statement-breakpoint
ALTER TABLE "chat_message_translations" ADD CONSTRAINT "chat_message_translations_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_purpose_check" CHECK ("llm_usage"."purpose" in ('translate', 'retry', 'judge', 'embed', 'chat'));