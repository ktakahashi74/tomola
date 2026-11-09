CREATE TABLE "stance_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stance_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"question_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"from_position" text,
	"to_position" text,
	"trigger_entry_id" bigint,
	"trigger_area" text,
	"area" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stance_changes_from_check" CHECK ("stance_changes"."from_position" in ('agree', 'disagree', 'neither')),
	CONSTRAINT "stance_changes_to_check" CHECK ("stance_changes"."to_position" in ('agree', 'disagree', 'neither')),
	CONSTRAINT "stance_changes_moves_check" CHECK ("stance_changes"."from_position" is distinct from "stance_changes"."to_position"),
	CONSTRAINT "stance_changes_trigger_area_check" CHECK ("stance_changes"."trigger_area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other')),
	CONSTRAINT "stance_changes_area_check" CHECK ("stance_changes"."area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other'))
);
--> statement-breakpoint
CREATE TABLE "stances" (
	"question_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"position" text NOT NULL,
	"area" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stances_question_id_user_id_pk" PRIMARY KEY("question_id","user_id"),
	CONSTRAINT "stances_position_check" CHECK ("stances"."position" in ('agree', 'disagree', 'neither')),
	CONSTRAINT "stances_area_check" CHECK ("stances"."area" in ('ja', 'en', 'fr', 'de', 'zh-Hant', 'zh-Hans', 'ko', 'th', 'vi', 'other')),
	CONSTRAINT "stances_version_check" CHECK ("stances"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_action_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_target_check";--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD COLUMN "revision_id" bigint;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "reactions_excluded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "reactions_excluded_action_id" bigint;--> statement-breakpoint
ALTER TABLE "stance_changes" ADD CONSTRAINT "stance_changes_question_id_entries_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stance_changes" ADD CONSTRAINT "stance_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stance_changes" ADD CONSTRAINT "stance_changes_trigger_entry_id_entries_id_fk" FOREIGN KEY ("trigger_entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stances" ADD CONSTRAINT "stances_question_id_entries_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stances" ADD CONSTRAINT "stances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stance_changes_pair_idx" ON "stance_changes" USING btree ("question_id","user_id","id");--> statement-breakpoint
CREATE INDEX "stance_changes_user_idx" ON "stance_changes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "stance_changes_created_idx" ON "stance_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stance_changes_trigger_idx" ON "stance_changes" USING btree ("trigger_entry_id");--> statement-breakpoint
CREATE INDEX "stances_user_idx" ON "stances" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_revision_id_entry_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."entry_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_reactions_excluded_action_id_moderation_actions_id_fk" FOREIGN KEY ("reactions_excluded_action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_fix_revision_check" CHECK ("moderation_actions"."action" <> 'fix_entry' or "moderation_actions"."revision_id" is not null);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" in ('hide', 'unhide', 'suspend', 'unsuspend', 'dismiss_report', 'delete', 'restore', 'exclude_reactions', 'include_reactions', 'fix_entry', 'unfix_entry'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_check" CHECK (("moderation_actions"."action" in ('hide', 'unhide', 'delete', 'restore', 'dismiss_report', 'fix_entry', 'unfix_entry') and "moderation_actions"."target_entry_id" is not null) or ("moderation_actions"."action" in ('suspend', 'unsuspend', 'exclude_reactions', 'include_reactions') and "moderation_actions"."target_user_id" is not null));