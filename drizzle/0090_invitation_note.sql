CREATE TABLE "invitation_note_translations" (
	"invitation_id" text NOT NULL,
	"lang" text NOT NULL,
	"text" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_note_translations_invitation_id_lang_pk" PRIMARY KEY("invitation_id","lang"),
	CONSTRAINT "invitation_note_translations_lang_check" CHECK ("invitation_note_translations"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "invitation_note_translations_state_check" CHECK ("invitation_note_translations"."state" in ('pending', 'ready', 'failed')),
	CONSTRAINT "invitation_note_translations_ready_check" CHECK ("invitation_note_translations"."state" <> 'ready' OR ("invitation_note_translations"."text" IS NOT NULL AND char_length("invitation_note_translations"."text") BETWEEN 1 AND 600))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "note_lang" text;--> statement-breakpoint
ALTER TABLE "invitation_note_translations" ADD CONSTRAINT "invitation_note_translations_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_note_lang_check" CHECK ("invitations"."note_lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi'));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_note_check" CHECK (("invitations"."note" IS NULL AND "invitations"."note_lang" IS NULL) OR ("invitations"."note" IS NOT NULL AND "invitations"."note_lang" IS NOT NULL AND char_length("invitations"."note") BETWEEN 1 AND 300));