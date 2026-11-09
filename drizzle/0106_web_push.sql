CREATE TABLE "push_deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "push_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"notification_id" integer NOT NULL,
	"subscription_id" text NOT NULL,
	"generation" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"notification_ids" jsonb,
	"batch_id" integer,
	"attempt_token" text,
	"attempt_started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"browser_secret_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"endpoint" text,
	"p256dh" text,
	"auth" text,
	"vapid_public_key" text NOT NULL,
	"browser" text NOT NULL,
	"os" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authorizing_session_id" text NOT NULL,
	"authorized_until" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_accepted_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"stopped_reason" text,
	CONSTRAINT "push_subscriptions_generation_check" CHECK ("push_subscriptions"."generation" > 0),
	CONSTRAINT "push_subscriptions_failures_check" CHECK ("push_subscriptions"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_notice_registration_unique" ON "push_deliveries" USING btree ("notification_id","subscription_id","generation");--> statement-breakpoint
CREATE INDEX "push_deliveries_pending_idx" ON "push_deliveries" USING btree ("subscription_id","generation","created_at") WHERE "push_deliveries"."completed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_unique" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "push_deliveries_user_idx" ON "push_deliveries" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "push_deliveries_subscription_idx" ON "push_deliveries" USING btree ("subscription_id");
