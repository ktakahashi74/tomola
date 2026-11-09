ALTER TABLE "invitations" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
ALTER TABLE "invitations" RENAME CONSTRAINT "invitations_token_unique" TO "invitations_token_hash_unique";--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "used_by" text;
