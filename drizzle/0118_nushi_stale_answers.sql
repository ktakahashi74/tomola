ALTER TABLE "nushi_requests" DROP CONSTRAINT "nushi_requests_entry_id_unique";--> statement-breakpoint
ALTER TABLE "nushi_answers" ADD COLUMN "sources_changed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nushi_answers" ADD COLUMN "superseded_by_id" bigint;--> statement-breakpoint
ALTER TABLE "nushi_requests" ADD COLUMN "replaces_answer_id" bigint;--> statement-breakpoint
ALTER TABLE "nushi_sources" ADD COLUMN "text_hash" text;--> statement-breakpoint
ALTER TABLE "nushi_answers" ADD CONSTRAINT "nushi_answers_superseded_by_id_nushi_answers_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."nushi_answers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nushi_requests" ADD CONSTRAINT "nushi_requests_replaces_answer_id_nushi_answers_id_fk" FOREIGN KEY ("replaces_answer_id") REFERENCES "public"."nushi_answers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nushi_requests_active_entry_unique" ON "nushi_requests" USING btree ("entry_id") WHERE "nushi_requests"."state" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "nushi_requests_entry_idx" ON "nushi_requests" USING btree ("entry_id");
--> statement-breakpoint

-- Bind retained source text without copying it. This is independent of source
-- language so a metadata-only correction can keep an otherwise identical text.
UPDATE nushi_sources s SET text_hash = (
  SELECT encode(sha256(convert_to(coalesce(h.title, ''), 'UTF8') || '\x00'::bytea || convert_to(h.body, 'UTF8')), 'hex')
  FROM entry_revisions h WHERE h.entry_id = s.entry_id AND h.mention_revision = s.revision AND h.deleted_at IS NULL ORDER BY h.id DESC LIMIT 1
);
--> statement-breakpoint
UPDATE nushi_sources s SET text_hash = encode(sha256(convert_to(coalesce(e.title, ''), 'UTF8') || '\x00'::bytea || convert_to(e.body, 'UTF8')), 'hex')
  FROM entries e WHERE e.id = s.entry_id AND e.mention_revision = s.revision;
--> statement-breakpoint
-- Public history keeps old passages readable. Active generation still requires
-- unchanged revisions; only already published answers receive a warning.
CREATE OR REPLACE FUNCTION nushi_withdraw_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.author_id, OLD.title, OLD.body, OLD.lang, OLD.lang_code, OLD.source_hash, OLD.mention_revision, OLD.hidden_at, OLD.deleted_at, OLD.village_id, OLD.thread_id, OLD.nushi_disabled)
     IS NOT DISTINCT FROM ROW(NEW.author_id, NEW.title, NEW.body, NEW.lang, NEW.lang_code, NEW.source_hash, NEW.mention_revision, NEW.hidden_at, NEW.deleted_at, NEW.village_id, NEW.thread_id, NEW.nushi_disabled) THEN RETURN NEW; END IF;
  IF NEW.nushi_disabled THEN
    UPDATE nushi_requests SET state = 'cancelled', failure = 'disabled', lease_until = NULL WHERE thread_id = NEW.id AND state IN ('pending', 'processing');
    UPDATE nushi_answers SET hidden_at = now(), hidden_reason = 'disabled' WHERE hidden_at IS NULL AND request_id IN (SELECT id FROM nushi_requests WHERE thread_id = NEW.id);
  END IF;
  IF ROW(OLD.author_id, OLD.title, OLD.body, OLD.lang, OLD.lang_code, OLD.source_hash, OLD.mention_revision, OLD.hidden_at, OLD.deleted_at, OLD.village_id, OLD.thread_id)
     IS NOT DISTINCT FROM ROW(NEW.author_id, NEW.title, NEW.body, NEW.lang, NEW.lang_code, NEW.source_hash, NEW.mention_revision, NEW.hidden_at, NEW.deleted_at, NEW.village_id, NEW.thread_id) THEN RETURN NEW; END IF;
  UPDATE nushi_requests SET state = 'cancelled', failure = 'changed', lease_until = NULL
    WHERE state IN ('pending', 'processing') AND (entry_id = NEW.id OR thread_id = NEW.id OR entry_id IN (SELECT id FROM entries WHERE parent_id = NEW.id));
  UPDATE nushi_answers a SET hidden_at = now(), hidden_reason = 'source_changed'
    WHERE a.hidden_at IS NULL AND EXISTS (
      SELECT 1 FROM nushi_sources s JOIN nushi_requests r ON r.id = a.request_id
        JOIN entries e ON e.id = s.entry_id JOIN entries root ON root.id = coalesce(e.thread_id, e.id)
        LEFT JOIN villages v ON v.id = root.village_id
      WHERE s.answer_id = a.id AND (s.entry_id = NEW.id OR root.id = NEW.id) AND (
        e.hidden_at IS NOT NULL OR e.deleted_at IS NOT NULL OR root.hidden_at IS NOT NULL OR root.deleted_at IS NOT NULL
        OR root.village_id IS DISTINCT FROM r.village_id OR e.author_id IS DISTINCT FROM s.author_id
        OR v.kind NOT IN ('personal', 'open', 'invite_public') OR (v.kind <> 'personal' AND v.slug IS NULL)
        OR (s.entry_id = NEW.id AND NOT (
          s.text_hash = encode(sha256(convert_to(coalesce(NEW.title, ''), 'UTF8') || '\x00'::bytea || convert_to(NEW.body, 'UTF8')), 'hex')
          OR (s.revision = OLD.mention_revision AND ROW(OLD.title, OLD.body) IS NOT DISTINCT FROM ROW(NEW.title, NEW.body))
          OR EXISTS (SELECT 1 FROM entry_revisions h WHERE h.entry_id = s.entry_id AND h.mention_revision = s.revision AND h.deleted_at IS NULL)
        ))
      )
    );
  UPDATE nushi_answers SET sources_changed = true WHERE hidden_at IS NULL
    AND id IN (SELECT answer_id FROM nushi_sources WHERE entry_id = NEW.id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nushi_withdraw_translation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(OLD.text, OLD.flags, OLD.source_hash, OLD.mention_revision) IS NOT DISTINCT FROM ROW(NEW.text, NEW.flags, NEW.source_hash, NEW.mention_revision) THEN RETURN NEW; END IF;
  UPDATE nushi_answers a SET sources_changed = true WHERE a.hidden_at IS NULL AND a.lang = OLD.lang
    AND a.id IN (SELECT answer_id FROM nushi_sources WHERE entry_id = OLD.entry_id)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.scope->'materialIndex') material
      WHERE material->>'id' IN ('e-' || OLD.entry_id || '-body', 'e-' || OLD.entry_id || '-title') AND material ? 'translation');
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE FUNCTION nushi_withdraw_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NULL AND ROW(OLD.title, OLD.body, OLD.mention_revision, OLD.entry_id) IS NOT DISTINCT FROM ROW(NEW.title, NEW.body, NEW.mention_revision, NEW.entry_id) THEN RETURN NEW; END IF;
  UPDATE nushi_answers a SET hidden_at = now(), hidden_reason = 'source_changed'
    WHERE a.hidden_at IS NULL AND a.id IN (
      SELECT s.answer_id FROM nushi_sources s JOIN entries e ON e.id = s.entry_id
      WHERE s.entry_id = OLD.entry_id AND s.revision = OLD.mention_revision
        AND ROW(e.title, e.body) IS DISTINCT FROM ROW(OLD.title, OLD.body)
        AND NOT EXISTS (SELECT 1 FROM entry_revisions h WHERE h.entry_id = s.entry_id AND h.mention_revision = s.revision AND h.deleted_at IS NULL AND h.id <> OLD.id)
    );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER nushi_withdraw_revision AFTER UPDATE OR DELETE ON entry_revisions FOR EACH ROW EXECUTE FUNCTION nushi_withdraw_revision();
