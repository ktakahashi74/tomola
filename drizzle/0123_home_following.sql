CREATE TABLE "member_follows" (
	"follower_id" text NOT NULL,
	"followed_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_follows_follower_id_followed_id_pk" PRIMARY KEY("follower_id","followed_id"),
	CONSTRAINT "member_follows_distinct_check" CHECK ("member_follows"."follower_id" <> "member_follows"."followed_id")
);
--> statement-breakpoint
ALTER TABLE "list_seen" DROP CONSTRAINT "list_seen_scope_check";
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "home_scope" text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
ALTER TABLE "member_follows" ADD CONSTRAINT "member_follows_follower_id_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "member_follows" ADD CONSTRAINT "member_follows_followed_id_user_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "member_follows_followed_idx" ON "member_follows" USING btree ("followed_id");
--> statement-breakpoint
ALTER TABLE "list_seen" ADD CONSTRAINT "list_seen_scope_check" CHECK (length("list_seen"."scope") <= 67 and ("list_seen"."scope" = '/?scope=following' or "list_seen"."scope" ~ '^(/|/a/[A-Za-z]{2,3}(-[A-Za-z]+)?/?|/v/[a-z0-9]+(-[a-z0-9]+)*/?)$'));
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_home_scope_check" CHECK ("profiles"."home_scope" in ('all', 'following'));
--> statement-breakpoint
-- Preserve the start time when a personal-village follow becomes a member follow.
INSERT INTO member_follows (follower_id, followed_id, created_at)
SELECT vf.user_id, v.owner_id, vf.created_at
FROM village_follows vf
JOIN villages v ON v.id = vf.village_id
JOIN "user" follower ON follower.id = vf.user_id
JOIN profiles follower_profile ON follower_profile.user_id = follower.id
JOIN "user" owner_account ON owner_account.id = v.owner_id
JOIN profiles owner_profile ON owner_profile.user_id = owner_account.id
WHERE v.kind = 'personal' AND v.ended_at IS NULL
  AND v.owner_id <> vf.user_id AND v.owner_id <> 'deleted-member'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Retain follows of ended shared villages so members can still remove them.
DELETE FROM village_follows vf USING villages v
WHERE vf.village_id = v.id AND (v.kind NOT IN ('open', 'invite_public') OR v.slug IS NULL);
--> statement-breakpoint
INSERT INTO village_follows (user_id, village_id, created_at)
SELECT vm.user_id, vm.village_id, vm.joined_at
FROM village_members vm
JOIN villages v ON v.id = vm.village_id
WHERE v.kind IN ('open', 'invite_public') AND v.slug IS NOT NULL AND v.ended_at IS NULL
ON CONFLICT DO NOTHING;
