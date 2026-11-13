CREATE TABLE "nushi_answers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nushi_answers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" text NOT NULL,
	"answer" jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"lang" text NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_reason" text,
	CONSTRAINT "nushi_answers_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "nushi_quota_lock" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nushi_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nushi_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"answer_id" bigint NOT NULL,
	"reporter_id" text,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"evidence" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nushi_reports_kind_check" CHECK ("nushi_reports"."kind" in ('moderation', 'error')),
	CONSTRAINT "nushi_reports_status_check" CHECK ("nushi_reports"."status" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "nushi_reports_consent_check" CHECK (("nushi_reports"."kind" = 'error') = ("nushi_reports"."evidence" is not null))
);
--> statement-breakpoint
CREATE TABLE "nushi_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"entry_id" bigint NOT NULL,
	"thread_id" bigint NOT NULL,
	"village_id" text NOT NULL,
	"caller_id" text,
	"revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "nushi_requests_entry_id_unique" UNIQUE("entry_id"),
	CONSTRAINT "nushi_requests_state_check" CHECK ("nushi_requests"."state" in ('pending', 'processing', 'answered', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "nushi_reservations" (
	"request_id" text NOT NULL,
	"key" text NOT NULL,
	"day" text NOT NULL,
	CONSTRAINT "nushi_reservations_request_id_key_pk" PRIMARY KEY("request_id","key")
);
--> statement-breakpoint
CREATE TABLE "nushi_sources" (
	"answer_id" bigint NOT NULL,
	"entry_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"author_id" text,
	"author" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "nushi_sources_answer_id_entry_id_pk" PRIMARY KEY("answer_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "nushi_translations" (
	"answer_id" bigint NOT NULL,
	"lang" text NOT NULL,
	"readings" jsonb NOT NULL,
	"engine" text NOT NULL,
	"model" text NOT NULL,
	CONSTRAINT "nushi_translations_answer_id_lang_pk" PRIMARY KEY("answer_id","lang")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "nushi_parent_id" bigint;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "nushi_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "nushi_request_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "nushi_day" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "hide_nushi" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "nushi_citation_notifications" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "villages" ADD COLUMN "nushi_enabled" boolean;--> statement-breakpoint
ALTER TABLE "nushi_answers" ADD CONSTRAINT "nushi_answers_request_id_nushi_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."nushi_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_reports" ADD CONSTRAINT "nushi_reports_answer_id_nushi_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."nushi_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_reports" ADD CONSTRAINT "nushi_reports_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_reports" ADD CONSTRAINT "nushi_reports_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_requests" ADD CONSTRAINT "nushi_requests_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_requests" ADD CONSTRAINT "nushi_requests_thread_id_entries_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_requests" ADD CONSTRAINT "nushi_requests_village_id_villages_id_fk" FOREIGN KEY ("village_id") REFERENCES "public"."villages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_requests" ADD CONSTRAINT "nushi_requests_caller_id_user_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_reservations" ADD CONSTRAINT "nushi_reservations_request_id_nushi_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."nushi_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_sources" ADD CONSTRAINT "nushi_sources_answer_id_nushi_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."nushi_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_sources" ADD CONSTRAINT "nushi_sources_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_sources" ADD CONSTRAINT "nushi_sources_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_translations" ADD CONSTRAINT "nushi_translations_answer_id_nushi_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."nushi_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nushi_reports_member_unique" ON "nushi_reports" USING btree ("answer_id","reporter_id","kind");--> statement-breakpoint
CREATE INDEX "nushi_reports_status_idx" ON "nushi_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "nushi_reports_reporter_idx" ON "nushi_reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "nushi_requests_thread_idx" ON "nushi_requests" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "nushi_requests_village_idx" ON "nushi_requests" USING btree ("village_id");--> statement-breakpoint
CREATE INDEX "nushi_requests_caller_idx" ON "nushi_requests" USING btree ("caller_id");--> statement-breakpoint
CREATE INDEX "nushi_requests_pending_idx" ON "nushi_requests" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "nushi_reservations_day_idx" ON "nushi_reservations" USING btree ("day","key");--> statement-breakpoint
CREATE INDEX "nushi_sources_entry_idx" ON "nushi_sources" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "nushi_sources_author_idx" ON "nushi_sources" USING btree ("author_id");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_nushi_parent_id_nushi_answers_id_fk" FOREIGN KEY ("nushi_parent_id") REFERENCES "public"."nushi_answers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_nushi_request_id_nushi_requests_id_fk" FOREIGN KEY ("nushi_request_id") REFERENCES "public"."nushi_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_nushi_citation_day_unique" ON "notifications" USING btree ("user_id","nushi_day") WHERE "notifications"."kind" = 'nushi_cited';--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_nushi_result_unique" ON "notifications" USING btree ("nushi_request_id") WHERE "notifications"."kind" = 'nushi_result';--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('reply_to_topic', 'reply_to_reply', 'response_to_topic', 'moderation', 'appeal_decided', 'followed_thread', 'mention', 'village_invite', 'village_added', 'village_removed', 'village_owner_changed', 'chat_mention', 'chat_reply', 'translation_report_result', 'source_language_mismatch', 'entry_translation_unavailable', 'nushi_result', 'nushi_cited'));--> statement-breakpoint
-- Withdraw derivatives in the same transaction as every source mutation,
-- including moderation and direct database writes. A later restoration never
-- republishes an answer based on a superseded revision.
CREATE FUNCTION nushi_withdraw_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nushi_disabled IS DISTINCT FROM OLD.nushi_disabled AND
     ROW(OLD.author_id, OLD.title, OLD.body, OLD.lang, OLD.lang_code, OLD.source_hash, OLD.mention_revision, OLD.hidden_at, OLD.deleted_at, OLD.village_id)
       IS NOT DISTINCT FROM ROW(NEW.author_id, NEW.title, NEW.body, NEW.lang, NEW.lang_code, NEW.source_hash, NEW.mention_revision, NEW.hidden_at, NEW.deleted_at, NEW.village_id) THEN
    IF NEW.nushi_disabled THEN
      UPDATE nushi_requests SET state = 'cancelled', failure = 'disabled', lease_until = NULL WHERE thread_id = NEW.id AND state IN ('pending', 'processing');
      UPDATE nushi_answers SET hidden_at = now(), hidden_reason = 'disabled' WHERE hidden_at IS NULL AND request_id IN (SELECT id FROM nushi_requests WHERE thread_id = NEW.id);
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(OLD.author_id, OLD.title, OLD.body, OLD.lang, OLD.lang_code, OLD.source_hash, OLD.mention_revision, OLD.hidden_at, OLD.deleted_at, OLD.village_id, OLD.nushi_disabled)
     IS NOT DISTINCT FROM ROW(NEW.author_id, NEW.title, NEW.body, NEW.lang, NEW.lang_code, NEW.source_hash, NEW.mention_revision, NEW.hidden_at, NEW.deleted_at, NEW.village_id, NEW.nushi_disabled) THEN RETURN NEW; END IF;
  UPDATE nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL
    WHERE state IN ('pending', 'processing') AND (entry_id = NEW.id OR thread_id = NEW.id OR entry_id IN (SELECT id FROM entries WHERE parent_id = NEW.id));
  UPDATE nushi_answers SET hidden_at = now(), hidden_reason = 'source_changed'
    WHERE hidden_at IS NULL AND (request_id IN (SELECT id FROM nushi_requests WHERE entry_id = NEW.id OR thread_id = NEW.id)
      OR id IN (SELECT answer_id FROM nushi_sources WHERE entry_id = NEW.id OR entry_id IN (SELECT id FROM entries WHERE thread_id = NEW.id)));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER nushi_withdraw_entry AFTER UPDATE ON entries FOR EACH ROW EXECUTE FUNCTION nushi_withdraw_entry();
--> statement-breakpoint
CREATE FUNCTION nushi_withdraw_village() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nushi_enabled IS FALSE OR (NEW.kind = 'personal' AND NEW.nushi_enabled IS NOT TRUE)
    OR NEW.language IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.kind NOT IN ('personal', 'open', 'invite_public')
    OR (NEW.kind <> 'personal' AND NEW.slug IS NULL) THEN
    UPDATE nushi_requests SET state = 'cancelled', failure = 'disabled', lease_until = NULL WHERE village_id = NEW.id AND state IN ('pending', 'processing');
    UPDATE nushi_answers SET hidden_at = now(), hidden_reason = 'disabled' WHERE hidden_at IS NULL AND request_id IN (SELECT id FROM nushi_requests WHERE village_id = NEW.id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER nushi_withdraw_village AFTER UPDATE ON villages FOR EACH ROW EXECUTE FUNCTION nushi_withdraw_village();
--> statement-breakpoint
CREATE FUNCTION nushi_withdraw_derivatives() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.hidden_at IS NULL AND NEW.hidden_at IS NOT NULL THEN
    DELETE FROM nushi_translations WHERE answer_id = NEW.id;
    WITH RECURSIVE affected(id) AS (
      SELECT NEW.id
      UNION
      SELECT child.id FROM affected parent
        JOIN entries call ON call.nushi_parent_id = parent.id
        JOIN nushi_requests request ON request.entry_id = call.id
        JOIN nushi_answers child ON child.request_id = request.id
    )
    UPDATE nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL
      WHERE state IN ('pending', 'processing') AND entry_id IN (SELECT id FROM entries WHERE nushi_parent_id IN (SELECT id FROM affected));
    WITH RECURSIVE affected(id) AS (
      SELECT NEW.id
      UNION
      SELECT child.id FROM affected parent
        JOIN entries call ON call.nushi_parent_id = parent.id
        JOIN nushi_requests request ON request.entry_id = call.id
        JOIN nushi_answers child ON child.request_id = request.id
    )
    UPDATE nushi_answers SET hidden_at = now(), hidden_reason = 'source_changed' WHERE hidden_at IS NULL AND id <> NEW.id AND id IN (SELECT id FROM affected);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER nushi_withdraw_derivatives AFTER UPDATE ON nushi_answers FOR EACH ROW EXECUTE FUNCTION nushi_withdraw_derivatives();
--> statement-breakpoint
CREATE FUNCTION nushi_notify_failure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notice_id bigint;
BEGIN
  IF NEW.state IN ('failed', 'cancelled') AND OLD.state IN ('pending', 'processing') AND NEW.caller_id IS NOT NULL THEN
    INSERT INTO notifications (user_id, kind, nushi_request_id, thread_id) VALUES (NEW.caller_id, 'nushi_result', NEW.id, NEW.thread_id) ON CONFLICT DO NOTHING RETURNING id INTO notice_id;
    IF notice_id IS NOT NULL THEN
      INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('email_nushi_result', jsonb_build_object('notificationId', notice_id), 'nushi-result-email:' || notice_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER nushi_notify_failure AFTER UPDATE ON nushi_requests FOR EACH ROW EXECUTE FUNCTION nushi_notify_failure();
--> statement-breakpoint
CREATE FUNCTION nushi_withdraw_translation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_entry bigint; affected_lang text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(OLD.text, OLD.flags, OLD.source_hash, OLD.mention_revision) IS NOT DISTINCT FROM ROW(NEW.text, NEW.flags, NEW.source_hash, NEW.mention_revision) THEN RETURN NEW; END IF;
  affected_entry := OLD.entry_id; affected_lang := OLD.lang;
  UPDATE nushi_answers SET hidden_at = now(), hidden_reason = 'source_changed' WHERE hidden_at IS NULL AND lang = affected_lang
    AND id IN (SELECT answer_id FROM nushi_sources WHERE entry_id = affected_entry);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER nushi_withdraw_translation AFTER UPDATE OR DELETE ON translations FOR EACH ROW EXECUTE FUNCTION nushi_withdraw_translation();
--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "target_nushi_answer_id" bigint;
--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_nushi_answer_id_nushi_answers_id_fk" FOREIGN KEY ("target_nushi_answer_id") REFERENCES "public"."nushi_answers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_target_check";
--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_check" CHECK (("moderation_actions"."target_nushi_answer_id" is null and (((((("moderation_actions"."action" in ('hide', 'unhide', 'delete', 'restore', 'dismiss_report', 'fix_entry', 'unfix_entry') and "moderation_actions"."target_entry_id" is not null) or ("moderation_actions"."action" in ('suspend', 'unsuspend', 'exclude_reactions', 'include_reactions', 'clear_display_name', 'restore_display_name', 'dismiss_display_name_report', 'clear_avatar', 'restore_avatar', 'dismiss_avatar_report') and "moderation_actions"."target_user_id" is not null)) and "moderation_actions"."target_village_id" is null and "moderation_actions"."target_chat_message_id" is null) or ("moderation_actions"."action" in ('fix_village', 'end_village', 'unfix_village', 'reopen_village', 'dismiss_village_report', 'clear_village_icon', 'restore_village_icon') and "moderation_actions"."target_village_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_chat_message_id" is null) or ("moderation_actions"."action" in ('hide_chat', 'unhide_chat', 'dismiss_chat_report') and "moderation_actions"."target_chat_message_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_village_id" is null)) and "moderation_actions"."target_media_id" is null) or ("moderation_actions"."action" = 'delete_media' and "moderation_actions"."target_media_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_village_id" is null and "moderation_actions"."target_chat_message_id" is null))) or ("moderation_actions"."action" = 'hide' and "moderation_actions"."target_nushi_answer_id" is not null and "moderation_actions"."target_entry_id" is null and "moderation_actions"."target_user_id" is null and "moderation_actions"."target_village_id" is null and "moderation_actions"."target_chat_message_id" is null and "moderation_actions"."target_media_id" is null));
