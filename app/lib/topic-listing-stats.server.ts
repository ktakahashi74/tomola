import { sql } from "drizzle-orm";
import type { Db } from "./db/client.server";

const expected = sql`select e.id as topic_id, e.lang, e.village_id, e.created_at, e.last_activity_at, e.asks_stance,
  coalesce(v.total, 0)::integer as insightful_count
  from entries e left join (
    select v.entry_id, count(*)::integer as total from votes v
    join profiles p on p.user_id = v.voter_id and p.reactions_excluded_at is null group by v.entry_id
  ) v on v.entry_id = e.id where e.kind = 'topic'`;

export type ListingRebuild = { mode: "dry-run" | "write"; topics: number; missing: number; different: number; unexpected: number };

// Preview a consistent snapshot by default. Applying a repair blocks source
// writers until both the comparison and replacement have committed together.
export async function rebuildTopicListingStats(db: Db, opts: { write?: boolean } = {}): Promise<ListingRebuild> {
  return db.transaction(async tx => {
    if (opts.write) {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`lock table entries, votes, profiles, topic_listing_stats in share row exclusive mode`);
    }
    const result = await tx.execute(sql`with expected as (${expected})
      select (select count(*)::int from expected) as topics,
        count(*) filter (where s.topic_id is null)::int as missing,
        count(*) filter (where e.topic_id is null)::int as unexpected,
        count(*) filter (where e.topic_id is not null and s.topic_id is not null and
          row(e.lang, e.village_id, e.created_at, e.last_activity_at, e.asks_stance, e.insightful_count)
          is distinct from row(s.lang, s.village_id, s.created_at, s.last_activity_at, s.asks_stance, s.insightful_count))::int as different
      from expected e full join topic_listing_stats s on s.topic_id = e.topic_id`) as { rows: Omit<ListingRebuild, "mode">[] };
    if (opts.write) {
      await tx.execute(sql`insert into topic_listing_stats (topic_id, lang, village_id, created_at, last_activity_at, asks_stance, insightful_count)
        ${expected} order by topic_id
        on conflict (topic_id) do update set lang = excluded.lang, village_id = excluded.village_id,
          created_at = excluded.created_at, last_activity_at = excluded.last_activity_at,
          asks_stance = excluded.asks_stance, insightful_count = excluded.insightful_count
        where row(topic_listing_stats.lang, topic_listing_stats.village_id, topic_listing_stats.created_at, topic_listing_stats.last_activity_at, topic_listing_stats.asks_stance, topic_listing_stats.insightful_count)
          is distinct from row(excluded.lang, excluded.village_id, excluded.created_at, excluded.last_activity_at, excluded.asks_stance, excluded.insightful_count)`);
      await tx.execute(sql`delete from topic_listing_stats s where not exists (select 1 from entries e where e.id = s.topic_id and e.kind = 'topic')`);
    }
    return { mode: opts.write ? "write" : "dry-run", ...result.rows[0] };
  }, opts.write ? undefined : { isolationLevel: "repeatable read", accessMode: "read only" });
}
