CREATE TABLE "handle_holds" (
	"handle_key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"held_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "handle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handle_holds" ADD CONSTRAINT "handle_holds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;