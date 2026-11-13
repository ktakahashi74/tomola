CREATE TABLE "post_ai_material_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "post_ai_material_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"topic_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"actor_id" text,
	"event" text DEFAULT 'edit' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"instruction_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_ai_material_versions_unique" UNIQUE("topic_id","version"),
	CONSTRAINT "post_ai_material_versions_event_check" CHECK ("post_ai_material_versions"."event" in ('edit', 'hide', 'unhide'))
);
--> statement-breakpoint
CREATE TABLE "post_ai_materials" (
	"instance_id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"topic_id" bigint PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"operator_hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "post_ai_materials_version_check" CHECK ("post_ai_materials"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "post_ai_material_versions" ADD CONSTRAINT "post_ai_material_versions_topic_id_post_ai_materials_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."post_ai_materials"("topic_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_ai_material_versions" ADD CONSTRAINT "post_ai_material_versions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_ai_materials" ADD CONSTRAINT "post_ai_materials_topic_id_entries_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;