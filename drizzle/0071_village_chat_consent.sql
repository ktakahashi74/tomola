CREATE TABLE "chat_consents" (
	"village_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_consents_village_id_user_id_pk" PRIMARY KEY("village_id","user_id"),
	CONSTRAINT "chat_consents_version_check" CHECK ("chat_consents"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "chat_consents" ADD CONSTRAINT "chat_consents_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_consents" ADD CONSTRAINT "chat_consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;