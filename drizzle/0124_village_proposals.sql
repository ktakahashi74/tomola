CREATE TABLE "village_proposals" (
	"id" text PRIMARY KEY DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"user_id" text NOT NULL,
	"client_key" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"village_id" text NOT NULL,
	"source_version" text NOT NULL,
	"name" text,
	"description" text,
	"icon_action" text NOT NULL,
	"icon_bytes" bytea,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "village_proposals_id_check" CHECK ("village_proposals"."id" ~ '^[a-f0-9]{32}$'),
	CONSTRAINT "village_proposals_source_version_check" CHECK ("village_proposals"."source_version" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "village_proposals_changes_check" CHECK ("village_proposals"."name" IS NOT NULL OR "village_proposals"."description" IS NOT NULL OR "village_proposals"."icon_action" <> 'keep'),
	CONSTRAINT "village_proposals_icon_check" CHECK (("village_proposals"."icon_action" IN ('keep', 'reset') AND "village_proposals"."icon_bytes" IS NULL) OR ("village_proposals"."icon_action" = 'replace' AND "village_proposals"."icon_bytes" IS NOT NULL AND octet_length("village_proposals"."icon_bytes") BETWEEN 1 AND 262144)),
	CONSTRAINT "village_proposals_expiry_check" CHECK ("village_proposals"."expires_at" > "village_proposals"."created_at")
);
--> statement-breakpoint
ALTER TABLE "village_proposals" ADD CONSTRAINT "village_proposals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_proposals" ADD CONSTRAINT "village_proposals_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "village_proposals_user_idx" ON "village_proposals" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "village_proposals_expiry_idx" ON "village_proposals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "village_proposals_village_idx" ON "village_proposals" USING btree ("village_id");
