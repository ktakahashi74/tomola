CREATE TABLE "draft_receipts" (
	"draft_id" bigint PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"client_key" text NOT NULL,
	"request_id" text,
	"request_hash" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"entry_id" bigint,
	"thread_id" bigint,
	"finished_at" timestamp with time zone,
	CONSTRAINT "draft_receipts_request_check" CHECK (("draft_receipts"."request_id" is null and "draft_receipts"."request_hash" is null) or
      ("draft_receipts"."request_id" is not null and length("draft_receipts"."request_id") between 1 and 128 and "draft_receipts"."request_hash" is not null)),
	CONSTRAINT "draft_receipts_state_check" CHECK (("draft_receipts"."state" = 'pending' and "draft_receipts"."finished_at" is null and "draft_receipts"."entry_id" is null and "draft_receipts"."thread_id" is null)
      or ("draft_receipts"."state" = 'published' and "draft_receipts"."finished_at" is not null and "draft_receipts"."entry_id" is not null and "draft_receipts"."thread_id" is not null)
      or ("draft_receipts"."state" = 'discarded' and "draft_receipts"."finished_at" is not null and "draft_receipts"."entry_id" is null and "draft_receipts"."thread_id" is null))
);
--> statement-breakpoint
CREATE TABLE "entry_edit_proposals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "entry_edit_proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"author_id" text NOT NULL,
	"client_key" text NOT NULL,
	"client_name" text NOT NULL,
	"entry_id" bigint NOT NULL,
	"entry_version" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"body" text,
	"lang" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "entry_edit_proposals_expiry_check" CHECK ("entry_edit_proposals"."expires_at" > "entry_edit_proposals"."created_at"),
	CONSTRAINT "entry_edit_proposals_version_check" CHECK ("entry_edit_proposals"."version" >= 1),
	CONSTRAINT "entry_edit_proposals_state_check" CHECK (("entry_edit_proposals"."state" = 'pending' and "entry_edit_proposals"."body" is not null and "entry_edit_proposals"."lang" is not null and "entry_edit_proposals"."finished_at" is null)
      or ("entry_edit_proposals"."state" in ('applied', 'discarded') and "entry_edit_proposals"."title" is null and "entry_edit_proposals"."body" is null and "entry_edit_proposals"."lang" is null and "entry_edit_proposals"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "draft_receipts" ADD CONSTRAINT "draft_receipts_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_edit_proposals" ADD CONSTRAINT "entry_edit_proposals_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_edit_proposals" ADD CONSTRAINT "entry_edit_proposals_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_receipts_request_idx" ON "draft_receipts" USING btree ("author_id","client_key","request_id");--> statement-breakpoint
CREATE INDEX "entry_edit_proposals_author_idx" ON "entry_edit_proposals" USING btree ("author_id","state");--> statement-breakpoint
CREATE INDEX "entry_edit_proposals_entry_idx" ON "entry_edit_proposals" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "entry_edit_proposals_expiry_idx" ON "entry_edit_proposals" USING btree ("expires_at");
--> statement-breakpoint
INSERT INTO draft_receipts (draft_id, author_id, client_key)
SELECT id, author_id, coalesce(client_key, 'token:' || token_id)
FROM drafts
WHERE via = 'api' AND (client_key IS NOT NULL OR token_id IS NOT NULL);
