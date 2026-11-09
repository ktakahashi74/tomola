CREATE TABLE "roles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"lang" text,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_role_check" CHECK ("roles"."role" in ('operator', 'moderator')),
	CONSTRAINT "roles_lang_check" CHECK (("roles"."role" = 'operator' and "roles"."lang" is null) or ("roles"."role" = 'moderator' and "roles"."lang" is not null and "roles"."lang" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi')))
);
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_user_role_lang_unique" ON "roles" USING btree ("user_id","role",(coalesce("lang", '')));--> statement-breakpoint
CREATE INDEX "roles_role_lang_idx" ON "roles" USING btree ("role","lang");