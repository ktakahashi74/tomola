CREATE TABLE "motion_delivery" (
	"day" date PRIMARY KEY NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motion_pairs" (
	"motion_id" text NOT NULL,
	"still_id" text NOT NULL,
	CONSTRAINT "motion_pairs_motion_id_still_id_pk" PRIMARY KEY("motion_id","still_id")
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "animated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "frames" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "loop" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "motion_pairs" ADD CONSTRAINT "motion_pairs_motion_id_media_id_fk" FOREIGN KEY ("motion_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motion_pairs" ADD CONSTRAINT "motion_pairs_still_id_media_id_fk" FOREIGN KEY ("still_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "motion_pairs_still_idx" ON "motion_pairs" USING btree ("still_id");