CREATE TABLE "member_signatures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "member_signatures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"entry_id" bigint,
	"source_hash" text,
	"operation" text NOT NULL,
	"payload" text NOT NULL,
	"payload_hash" text NOT NULL,
	"challenge" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"rp_id" text NOT NULL,
	"origin" text NOT NULL,
	"assertion" jsonb NOT NULL,
	"authenticator_data" text NOT NULL,
	"client_data_json" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_signatures_challenge_unique" UNIQUE("challenge")
);
--> statement-breakpoint
CREATE TABLE "passkey_recoveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "passkey_recoveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"operator_id" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_challenges" (
	"challenge" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" text NOT NULL,
	"payload_hash" text NOT NULL,
	"form_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "signing_challenges_expiry_check" CHECK ("signing_challenges"."expires_at" > "signing_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "passkey_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "passkey_recovery_until" timestamp with time zone;--> statement-breakpoint
-- Existing credentials must never become an unsigned first-enrollment bypass after their removal.
UPDATE "profiles" AS p SET "passkey_enrolled_at" = coalesce((SELECT min(k."created_at") FROM "passkey" AS k WHERE k."user_id" = p."user_id"), now())
WHERE EXISTS (SELECT 1 FROM "passkey" AS k WHERE k."user_id" = p."user_id");--> statement-breakpoint
ALTER TABLE "member_signatures" ADD CONSTRAINT "member_signatures_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_signatures" ADD CONSTRAINT "member_signatures_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_recoveries" ADD CONSTRAINT "passkey_recoveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_recoveries" ADD CONSTRAINT "passkey_recoveries_operator_id_user_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_challenges" ADD CONSTRAINT "signing_challenges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_signatures_user_idx" ON "member_signatures" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "member_signatures_entry_idx" ON "member_signatures" USING btree ("entry_id","source_hash");--> statement-breakpoint
CREATE INDEX "signing_challenges_user_idx" ON "signing_challenges" USING btree ("user_id","expires_at");--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_version_check" CHECK ("drafts"."version" >= 1);
