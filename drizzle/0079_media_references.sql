CREATE TABLE "entry_media" (
	"entry_id" bigint NOT NULL,
	"media_id" text NOT NULL,
	CONSTRAINT "entry_media_entry_id_media_id_pk" PRIMARY KEY("entry_id","media_id")
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_action_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "target_media_id" text;--> statement-breakpoint
ALTER TABLE "entry_media" ADD CONSTRAINT "entry_media_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_media" ADD CONSTRAINT "entry_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_media_media_idx" ON "entry_media" USING btree ("media_id","entry_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_media_id_media_id_fk" FOREIGN KEY ("target_media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('hide', 'unhide', 'suspend', 'unsuspend', 'dismiss_report', 'delete', 'restore', 'exclude_reactions', 'include_reactions', 'fix_entry', 'unfix_entry', 'fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report', 'hide_chat', 'unhide_chat', 'dismiss_chat_report', 'delete_media'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_check" CHECK (((((("moderation_actions"."action" in ('hide', 'unhide', 'delete', 'restore', 'dismiss_report', 'fix_entry', 'unfix_entry') and "moderation_actions"."target_entry_id" is not null) or ("moderation_actions"."action" in ('suspend', 'unsuspend', 'exclude_reactions', 'include_reactions') and "moderation_actions"."target_user_id" is not null)) and "moderation_actions"."target_village_id" is null and "moderation_actions"."target_chat_message_id" is null) or ("moderation_actions"."action" in ('fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report') and "moderation_actions"."target_village_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_chat_message_id" is null) or ("moderation_actions"."action" in ('hide_chat', 'unhide_chat', 'dismiss_chat_report') and "moderation_actions"."target_chat_message_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_village_id" is null)) and "moderation_actions"."target_media_id" is null) or ("moderation_actions"."action" = 'delete_media' and "moderation_actions"."target_media_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_village_id" is null and "moderation_actions"."target_chat_message_id" is null));
--> statement-breakpoint
-- Backfill original post references, including hidden and deleted originals.
INSERT INTO entry_media (entry_id, media_id)
SELECT DISTINCT e.id, found.path[1]
FROM entries e
CROSS JOIN LATERAL regexp_matches(e.body, '/media/([a-f0-9]{64})-[1-9][0-9]{0,3}x[1-9][0-9]{0,3}\.webp\y', 'g') AS found(path)
JOIN media m ON m.id = found.path[1]
ON CONFLICT DO NOTHING;
