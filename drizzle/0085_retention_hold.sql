CREATE TABLE "retention_hold" (
	"id" integer PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_hold_singleton_check" CHECK ("retention_hold"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "retention_hold" ("id") VALUES (1);
