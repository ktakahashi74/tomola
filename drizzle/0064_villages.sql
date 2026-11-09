CREATE TABLE "village_members" (
	"village_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "village_members_village_id_user_id_pk" PRIMARY KEY("village_id","user_id"),
	CONSTRAINT "village_members_role_check" CHECK ("village_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "villages" (
	"id" text PRIMARY KEY DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"slug" text,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"language" text,
	"system" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "villages_slug_unique" UNIQUE("slug"),
	CONSTRAINT "villages_language_unique" UNIQUE("language"),
	CONSTRAINT "villages_id_check" CHECK ("villages"."id" ~ '^[a-f0-9]{32}$'),
	CONSTRAINT "villages_slug_check" CHECK ("villages"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "villages_kind_check" CHECK ("villages"."kind" in ('open', 'closed', 'invite_public')),
	CONSTRAINT "villages_language_check" CHECK ("villages"."language" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')),
	CONSTRAINT "villages_language_active_check" CHECK ("villages"."language" IS NULL OR ("villages"."system" AND "villages"."kind" = 'open' AND "villages"."slug" = lower("villages"."language") AND "villages"."ended_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "village_id" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "default_village_id" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "village_prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "village_members" ADD CONSTRAINT "village_members_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_members" ADD CONSTRAINT "village_members_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "villages" ADD CONSTRAINT "villages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "village_members_user_idx" ON "village_members" USING btree ("user_id","joined_at");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_default_village_id_villages_id_fk" FOREIGN KEY ("default_village_id") REFERENCES "public"."villages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_topic_village_created_idx" ON "entries" USING btree ("village_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "entries"."kind" = 'topic' and "entries"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "entries_topic_village_activity_idx" ON "entries" USING btree ("village_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "entries"."kind" = 'topic' and "entries"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_village_topic_check" CHECK ("entries"."kind" = 'topic' OR "entries"."village_id" IS NULL);