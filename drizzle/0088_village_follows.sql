CREATE TABLE "village_follows" (
	"user_id" text NOT NULL,
	"village_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "village_follows_user_id_village_id_pk" PRIMARY KEY("user_id","village_id")
);
--> statement-breakpoint
ALTER TABLE "village_follows" ADD CONSTRAINT "village_follows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "village_follows" ADD CONSTRAINT "village_follows_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "village_follows_village_idx" ON "village_follows" USING btree ("village_id");