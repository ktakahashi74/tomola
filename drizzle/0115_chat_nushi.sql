CREATE TABLE "chat_nushi_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"message_id" text NOT NULL,
	"village_id" text NOT NULL,
	"caller_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"answer_message_id" text,
	"notified_at" timestamp with time zone,
	CONSTRAINT "chat_nushi_requests_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "chat_nushi_requests_answer_message_id_unique" UNIQUE("answer_message_id"),
	CONSTRAINT "chat_nushi_requests_state_check" CHECK ("chat_nushi_requests"."state" in ('pending', 'processing', 'answered', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "chat_nushi_reservations" (
	"request_id" text NOT NULL,
	"key" text NOT NULL,
	"day" text NOT NULL,
	CONSTRAINT "chat_nushi_reservations_request_id_key_pk" PRIMARY KEY("request_id","key")
);
--> statement-breakpoint
CREATE TABLE "chat_nushi_sources" (
	"request_id" text NOT NULL,
	"entry_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"author_id" text,
	CONSTRAINT "chat_nushi_sources_request_id_entry_id_pk" PRIMARY KEY("request_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "nushi_shape" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "author_kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_nushi_requests" ADD CONSTRAINT "chat_nushi_requests_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_requests" ADD CONSTRAINT "chat_nushi_requests_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_requests" ADD CONSTRAINT "chat_nushi_requests_caller_id_user_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_requests" ADD CONSTRAINT "chat_nushi_requests_answer_message_id_chat_messages_id_fk" FOREIGN KEY ("answer_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_reservations" ADD CONSTRAINT "chat_nushi_reservations_request_id_chat_nushi_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."chat_nushi_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_sources" ADD CONSTRAINT "chat_nushi_sources_request_id_chat_nushi_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."chat_nushi_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_sources" ADD CONSTRAINT "chat_nushi_sources_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_nushi_sources" ADD CONSTRAINT "chat_nushi_sources_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_nushi_requests_active_idx" ON "chat_nushi_requests" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "chat_nushi_requests_village_idx" ON "chat_nushi_requests" USING btree ("village_id");--> statement-breakpoint
CREATE INDEX "chat_nushi_reservations_day_idx" ON "chat_nushi_reservations" USING btree ("day","key");--> statement-breakpoint
CREATE INDEX "chat_nushi_sources_entry_idx" ON "chat_nushi_sources" USING btree ("entry_id");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_check" CHECK (("chat_messages"."author_kind" = 'human' AND "chat_messages"."author_id" IS NOT NULL) OR ("chat_messages"."author_kind" = 'nushi' AND "chat_messages"."author_id" IS NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'response_to_topic', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_added', 'village_removed', 'village_owner_changed', 'chat_mention', 'chat_reply', 'translation_report_result', 'source_language_mismatch', 'entry_translation_unavailable', 'nushi_result', 'nushi_cited', 'chat_nushi_result', 'chat_nushi_cited'));--> statement-breakpoint
CREATE UNIQUE INDEX notifications_chat_nushi_citation_day_unique ON notifications (user_id, nushi_day) WHERE kind = 'chat_nushi_cited';
--> statement-breakpoint
CREATE FUNCTION withdraw_chat_nushi(request_ids text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE place text; horizon bigint; total integer;
BEGIN
  IF coalesce(array_length(request_ids, 1), 0) = 0 THEN RETURN; END IF;
  FOR place IN SELECT DISTINCT village_id FROM chat_nushi_requests WHERE id = ANY(request_ids) AND answer_message_id IS NOT NULL ORDER BY village_id LOOP
    SELECT count(*)::int INTO total FROM chat_messages WHERE hidden_at IS NULL AND id IN (SELECT answer_message_id FROM chat_nushi_requests WHERE id = ANY(request_ids) AND village_id = place);
    IF total = 0 THEN CONTINUE; END IF;
    INSERT INTO chat_sequences(village_id, seq) VALUES(place, total) ON CONFLICT (village_id) DO UPDATE SET seq = chat_sequences.seq + excluded.seq RETURNING seq INTO horizon;
    WITH changed AS (
      SELECT id, row_number() OVER (ORDER BY created_seq, id) AS ordinal FROM chat_messages
        WHERE hidden_at IS NULL AND id IN (SELECT answer_message_id FROM chat_nushi_requests WHERE id = ANY(request_ids) AND village_id = place)
    ) UPDATE chat_messages SET body = '', hidden_at = coalesce(hidden_at, now()), changed_seq = horizon - total + changed.ordinal
      FROM changed WHERE chat_messages.id = changed.id;
  END LOOP;
  DELETE FROM chat_message_translations WHERE message_id IN (SELECT answer_message_id FROM chat_nushi_requests WHERE id = ANY(request_ids));
END $$;
--> statement-breakpoint
CREATE FUNCTION chat_nushi_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[];
BEGIN
  IF (NEW.body, NEW.title, NEW.lang, NEW.lang_code, NEW.author_id, NEW.thread_id, NEW.parent_id, NEW.hidden_at, NEW.deleted_at, NEW.village_id, NEW.mention_revision)
      IS NOT DISTINCT FROM (OLD.body, OLD.title, OLD.lang, OLD.lang_code, OLD.author_id, OLD.thread_id, OLD.parent_id, OLD.hidden_at, OLD.deleted_at, OLD.village_id, OLD.mention_revision) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT request_id) INTO affected FROM chat_nushi_sources WHERE entry_id = NEW.id OR entry_id IN (SELECT id FROM entries WHERE thread_id = NEW.id);
  PERFORM withdraw_chat_nushi(affected);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_source_changed AFTER UPDATE ON entries FOR EACH ROW EXECUTE FUNCTION chat_nushi_source_changed();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_translation_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[];
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.text, NEW.flags, NEW.source_hash, NEW.lang, NEW.mention_revision) IS NOT DISTINCT FROM (OLD.text, OLD.flags, OLD.source_hash, OLD.lang, OLD.mention_revision) THEN RETURN NEW; END IF;
  SELECT array_agg(DISTINCT request_id) INTO affected FROM chat_nushi_sources WHERE entry_id = OLD.entry_id;
  PERFORM withdraw_chat_nushi(affected);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_translation_changed AFTER UPDATE OR DELETE ON translations FOR EACH ROW EXECUTE FUNCTION chat_nushi_translation_changed();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_call_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[]; place text; horizon bigint;
BEGIN
  IF NEW.author_kind = 'nushi' THEN RETURN NEW; END IF;
  IF (NEW.body, NEW.lang, NEW.edited_at, NEW.deleted_at, NEW.hidden_at) IS NOT DISTINCT FROM (OLD.body, OLD.lang, OLD.edited_at, OLD.deleted_at, OLD.hidden_at) THEN RETURN NEW; END IF;
  UPDATE chat_nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL WHERE message_id = NEW.id AND state IN ('pending', 'processing');
  SELECT array_agg(id) INTO affected FROM chat_nushi_requests WHERE message_id = NEW.id AND answer_message_id IS NOT NULL;
  IF NEW.deleted_at IS NOT NULL OR NEW.hidden_at IS NOT NULL THEN PERFORM withdraw_chat_nushi(affected);
  ELSIF coalesce(array_length(affected, 1), 0) > 0 THEN
    INSERT INTO chat_sequences(village_id, seq) VALUES(NEW.village_id, 1) ON CONFLICT (village_id) DO UPDATE SET seq = chat_sequences.seq + 1 RETURNING seq INTO horizon;
    UPDATE chat_messages SET changed_seq = greatest(created_seq, horizon) WHERE id IN (SELECT answer_message_id FROM chat_nushi_requests WHERE id = ANY(affected));
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_call_changed AFTER UPDATE ON chat_messages FOR EACH ROW EXECUTE FUNCTION chat_nushi_call_changed();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_village_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[];
BEGIN
  IF NEW.nushi_enabled IS FALSE OR (NEW.kind = 'personal' AND NEW.nushi_enabled IS NOT TRUE) OR NEW.ended_at IS NOT NULL OR NEW.language IS NOT NULL OR NEW.kind NOT IN ('open', 'invite_public', 'personal') THEN
    UPDATE chat_nushi_requests SET state = 'cancelled', failure = 'disabled', lease_until = NULL WHERE village_id = NEW.id AND state IN ('pending', 'processing');
    SELECT array_agg(id) INTO affected FROM chat_nushi_requests WHERE village_id = NEW.id AND answer_message_id IS NOT NULL;
    PERFORM withdraw_chat_nushi(affected);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_village_changed AFTER UPDATE ON villages FOR EACH ROW EXECUTE FUNCTION chat_nushi_village_changed();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_member_left() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chat_nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL WHERE village_id = OLD.village_id AND caller_id = OLD.user_id AND state IN ('pending', 'processing');
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_member_left AFTER DELETE ON village_members FOR EACH ROW EXECUTE FUNCTION chat_nushi_member_left();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_consent_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN RETURN NEW; END IF;
  UPDATE chat_nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL WHERE village_id = OLD.village_id AND caller_id = OLD.user_id AND state IN ('pending', 'processing');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_consent_changed AFTER UPDATE OR DELETE ON chat_consents FOR EACH ROW EXECUTE FUNCTION chat_nushi_consent_changed();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_member_stopped() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.suspended_until IS NOT NULL AND NEW.suspended_until > now() THEN
    UPDATE chat_nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL WHERE caller_id = NEW.user_id AND state IN ('pending', 'processing');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_member_stopped AFTER UPDATE OF suspended_until ON profiles FOR EACH ROW EXECUTE FUNCTION chat_nushi_member_stopped();
--> statement-breakpoint
CREATE FUNCTION chat_nushi_failed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notice_id bigint; horizon bigint;
BEGIN
  IF NEW.state IN ('cancelled', 'failed') AND OLD.state IN ('pending', 'processing') AND NEW.notified_at IS NULL AND NEW.caller_id IS NOT NULL THEN
    INSERT INTO chat_sequences(village_id, seq) VALUES(NEW.village_id, 1) ON CONFLICT (village_id) DO UPDATE SET seq = chat_sequences.seq + 1 RETURNING seq INTO horizon;
    UPDATE chat_messages SET changed_seq = greatest(created_seq, horizon) WHERE id = NEW.message_id;
    INSERT INTO notifications(user_id, kind, village_id, chat_message_id) VALUES(NEW.caller_id, 'chat_nushi_result', NEW.village_id, NEW.message_id) RETURNING id INTO notice_id;
    UPDATE chat_nushi_requests SET notified_at = now() WHERE id = NEW.id;
    INSERT INTO jobs(kind, payload, dedupe_key) VALUES('email_chat_nushi_result', jsonb_build_object('notificationId', notice_id), 'chat-nushi-result-email:' || notice_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_nushi_failed AFTER UPDATE ON chat_nushi_requests FOR EACH ROW EXECUTE FUNCTION chat_nushi_failed();
