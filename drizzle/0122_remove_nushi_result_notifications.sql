DROP TRIGGER nushi_notify_failure ON nushi_requests;
--> statement-breakpoint
DROP FUNCTION nushi_notify_failure();
--> statement-breakpoint
-- Keep the chat change cursor moving so polling clients can show terminal call states.
CREATE OR REPLACE FUNCTION chat_nushi_failed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE horizon bigint;
BEGIN
  IF NEW.state IN ('cancelled', 'failed') AND OLD.state IN ('pending', 'processing') AND NEW.caller_id IS NOT NULL THEN
    INSERT INTO chat_sequences(village_id, seq) VALUES(NEW.village_id, 1) ON CONFLICT (village_id) DO UPDATE SET seq = chat_sequences.seq + 1 RETURNING seq INTO horizon;
    UPDATE chat_messages SET changed_seq = greatest(created_seq, horizon) WHERE id = NEW.message_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
ALTER TABLE "chat_nushi_requests" DROP COLUMN "notified_at";
--> statement-breakpoint
DELETE FROM jobs WHERE kind IN ('email_nushi_result', 'email_chat_nushi_result');
--> statement-breakpoint
-- Remove pending immediate emails that already passed through the old handlers.
DELETE FROM jobs USING notifications
WHERE jobs.kind = 'send_notification_email' AND jobs.status IN ('queued', 'running')
  AND notifications.kind IN ('nushi_result', 'chat_nushi_result')
  AND jobs.dedupe_key = 'notification-email:' || notifications.id;
--> statement-breakpoint
DELETE FROM notifications WHERE kind IN ('nushi_result', 'chat_nushi_result');
--> statement-breakpoint
DROP INDEX "notifications_nushi_result_unique";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'response_to_topic', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_added', 'village_removed', 'village_owner_changed', 'chat_mention', 'chat_reply', 'translation_report_result', 'source_language_mismatch', 'entry_translation_unavailable', 'nushi_cited', 'chat_nushi_cited'));
