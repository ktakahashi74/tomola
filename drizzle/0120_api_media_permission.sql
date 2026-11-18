ALTER TABLE api_tokens ADD COLUMN media_upload boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_media_draft_check CHECK (NOT media_upload OR kind = 'draft');
