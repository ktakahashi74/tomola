CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"bytes" "bytea",
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_id_check" CHECK ("media"."id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "media_mime_check" CHECK ("media"."mime" = 'image/webp'),
	CONSTRAINT "media_dimensions_check" CHECK ("media"."width" BETWEEN 1 AND 2000 AND "media"."height" BETWEEN 1 AND 2000),
	CONSTRAINT "media_size_check" CHECK ("media"."byte_size" BETWEEN 1 AND 2097152),
	CONSTRAINT "media_content_check" CHECK (("media"."deleted_at" IS NULL AND "media"."bytes" IS NOT NULL AND octet_length("media"."bytes") = "media"."byte_size") OR ("media"."deleted_at" IS NOT NULL AND "media"."bytes" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_uploaded_by_idx" ON "media" USING btree ("uploaded_by");