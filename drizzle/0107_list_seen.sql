CREATE TABLE "list_seen" (
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_seen_user_id_scope_pk" PRIMARY KEY("user_id","scope"),
	CONSTRAINT "list_seen_scope_check" CHECK (length("list_seen"."scope") <= 67 and "list_seen"."scope" ~ '^(/|/a/[A-Za-z]{2,3}(-[A-Za-z]+)?/?|/v/[a-z0-9]+(-[a-z0-9]+)*/?)$')
);
--> statement-breakpoint
ALTER TABLE "list_seen" ADD CONSTRAINT "list_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "list_seen_member_order_idx" ON "list_seen" USING btree ("user_id","updated_at" DESC NULLS LAST,"scope");