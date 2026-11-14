import { eq, sql, type SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, vi } from "vitest";
import { migrationsFolder, type Db } from "~/lib/db/client.server";
import { entries, jobs, profiles, topicListingStats, villages } from "~/lib/db/schema";
import { getThread, listTopics } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { putMedia } from "~/lib/media-store.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { holdTx } from "./helpers/pg-concurrency";
import { createScratchDb } from "./helpers/pg-real";

vi.mock("~/lib/media", async original => {
  const module = await original<typeof import("~/lib/media")>();
  return { ...module, MEDIA_LIMITS: { ...module.MEDIA_LIMITS, memberStoredBytes: 16, siteStoredBytes: 24 } };
});

function bind(query: string, params: unknown[]): SQL {
  const statement = sql.empty();
  let end = 0;
  for (const match of query.matchAll(/\$(\d+)/g)) {
    statement.append(sql.raw(query.slice(end, match.index)));
    statement.append(sql`${params[Number(match[1]) - 1]}`);
    end = match.index! + match[0].length;
  }
  return statement.append(sql.raw(query.slice(end)));
}
async function plan(db: Db, query: SQL) {
  const result = await db.execute(sql`explain (analyze, buffers, format json) ${query}`) as { rows: { "QUERY PLAN": unknown }[] };
  return JSON.stringify(result.rows[0]["QUERY PLAN"]);
}
const topic = async (db: Db, authorId: string) => (await db.insert(entries).values({ kind: "topic", lang: "en", authorId, title: "Ordered topic", body: "Topic", html: "<p>Topic</p>", htmlVersion: RENDER_VERSION }).returning())[0];

describe.skipIf(!PG_MODE)("PostgreSQL listing indexes, HOT updates and admission races", { tags: ["postgres"] }, () => {
  it("upgrades populated tables and backfills counted topic votes without changing existing posts", async () => {
    const scratch = await createScratchDb({ migrate: false });
    try {
      const admin = await scratch.admin();
      const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder() });
      await admin.query("BEGIN");
      for (const migration of migrations.slice(0, 82)) await admin.query(migration.sql.join("\n"));
      await admin.query("COMMIT");
      const db = await scratch.open();
      // The checkpoint has historical columns; current registration writes newer ones.
      for (const id of ["upgrade_writer", "upgrade_voter", "upgrade_excluded"]) {
        await admin.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, '', $2, true)`, [id, `${id}@example.invalid`]);
        await admin.query(`INSERT INTO profiles (user_id, handle, handle_key, home_area, read_langs) VALUES ($1, $1, $1, 'ja', ARRAY['ja'])`, [id]);
      }
      // Write checkpoint rows without current code paths that use later columns.
      const inserted = await admin.query(`INSERT INTO entries (kind, lang, author_id, title, body, html, html_version) VALUES ('topic', 'en', 'upgrade_writer', 'Ordered topic', 'Topic', '<p>Topic</p>', $1) RETURNING id, last_activity_at`, [RENDER_VERSION]);
      const root = { id: Number(inserted.rows[0].id), lastActivityAt: inserted.rows[0].last_activity_at as Date };
      await db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "upgrade_excluded"));
      for (const voterId of ["upgrade_voter", "upgrade_excluded"]) await admin.query(`INSERT INTO votes (entry_id, voter_id, voter_area) VALUES ($1, $2, 'ja')`, [root.id, voterId]);
      await db.insert(jobs).values({ kind: "translate_entry", status: "done", payload: { entryId: root.id, paidTranslationCalls: { old: { text: "Legacy translation" } } } });
      const entryRows = async () => (await admin.query(`SELECT * FROM entries ORDER BY id`)).rows.map(({ history_started_at: _added, lang_code: _langCode, lang_source: _langSource, nushi_disabled: _nushiDisabled, nushi_parent_id: _nushiParentId, ...row }: Record<string, unknown>) => row);
      const before = await entryRows();
      await admin.query("BEGIN");
      for (const migration of migrations.slice(82)) await admin.query(migration.sql.join("\n"));
      await admin.query("COMMIT");
      expect(await entryRows()).toEqual(before);
      expect((await admin.query(`SELECT lang_code, lang_source FROM entries ORDER BY id`)).rows).toEqual(before.map(() => ({ lang_code: null, lang_source: null })));
      expect((await admin.query(`SELECT nushi_disabled, nushi_parent_id FROM entries ORDER BY id`)).rows).toEqual(before.map(() => ({ nushi_disabled: false, nushi_parent_id: null })));
      expect((await db.select().from(jobs))[0].payload).toEqual({ entryId: root.id });
      expect(await db.select().from(topicListingStats)).toMatchObject([{ topicId: root.id, insightfulCount: 1, lastActivityAt: root.lastActivityAt }]);
      await setVote(db, "upgrade_voter", root.id, false);
      expect((await db.select().from(topicListingStats))[0].insightfulCount).toBe(0);
    } finally { await scratch.drop(); }
  }, 30_000);

  it("seeks reply keys with the ordered index and returns the same tied/deleted positions", async () => {
    const seen: { query: string; params: unknown[] }[] = [];
    const db = await createTestDb({ logger: { logQuery(query, params) { seen.push({ query, params }); } } });
    await addMember(db, "seek_writer", "seek_writer");
    const root = await topic(db, "seek_writer");
    await db.execute(sql`insert into entries(kind, thread_id, author_id, lang, body, html, html_version, created_at)
      select 'reply', ${root.id}, 'seek_writer', 'en', 'Reply', '<p>Reply</p>', ${RENDER_VERSION}, '2030-01-01'::timestamptz
      from generate_series(1, 600)`);
    const all = await db.select({ id: entries.id }).from(entries).where(eq(entries.threadId, root.id)).orderBy(entries.createdAt, entries.id);
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, all[120].id));
    seen.length = 0;
    const thread = await getThread(db, root.id, { page: 21, limit: 10 });
    expect(thread).toMatchObject({ replyTotal: 600, pageCount: 60 });
    expect(thread!.replies.map(row => row.id)).toEqual(all.slice(200, 210).map(row => row.id));
    const read = seen.find(row => row.query.includes('"entries"."body"') && row.query.includes("order by"))!;
    expect(read).toBeDefined();
    const shape = await plan(db, bind(read.query, read.params));
    expect(shape).toContain("entries_thread_idx");
    expect(shape).toMatch(/Index Cond[^\n]*created_at/);
    expect((await getThread(db, root.id, { page: 100, limit: 10 }))!.replies).toEqual([]);
  });

  it("uses entity and dedupe indexes for unfinished/failed jobs", async () => {
    const db = await createTestDb();
    await db.execute(sql`insert into jobs(kind, payload, status, dedupe_key)
      select case when g % 2 = 0 then 'translate_entry' else 'translate_chat' end,
        jsonb_build_object('entryId', g, 'messageId', g::text),
        case when g % 3 = 0 then 'failed' when g % 3 = 1 then 'done' else 'queued' end,
        'job-' || g from generate_series(1, 4000) g`);
    await db.execute(sql`analyze jobs`);
    const entryPlan = await plan(db, sql`select id from jobs where kind = 'translate_entry' and payload->>'entryId' = '42' and status in ('queued','running','failed')`);
    expect(entryPlan).toContain("jobs_entry_idx");
    expect(await plan(db, sql`select id from jobs where kind = 'translate_chat' and payload->>'messageId' = '41' and status = 'queued'`)).toContain("jobs_message_idx");
    expect(await plan(db, sql`select id from jobs where kind = 'translate_chat' and dedupe_key = 'job-51' and status = 'failed'`)).toContain("jobs_kind_dedupe_idx");
  });

  it("uses HOT for activity-only post updates and seeks the narrow activity/ranking indexes", async () => {
    const seen: { query: string; params: unknown[] }[] = [];
    const db = await createTestDb({ logger: { logQuery(query, params) { seen.push({ query, params }); } } });
    await addMember(db, "hot_writer", "hot_writer");
    const root = await topic(db, "hot_writer");
    await db.transaction(async tx => {
      const before = await tx.execute(sql`select pg_stat_get_xact_tuples_hot_updated('entries'::regclass) as n`) as { rows: { n: string }[] };
      await tx.update(entries).set({ replyCount: 1, lastActivityAt: new Date("2030-01-01") }).where(eq(entries.id, root.id));
      const after = await tx.execute(sql`select pg_stat_get_xact_tuples_hot_updated('entries'::regclass) as n`) as { rows: { n: string }[] };
      expect(Number(after.rows[0].n)).toBeGreaterThan(Number(before.rows[0].n));
    });
    await db.execute(sql`insert into entries(kind, author_id, lang, body, created_at, last_activity_at)
      select 'topic', 'hot_writer', 'en', 'Topic', '2030-01-01'::timestamptz + g * interval '1 second', '2030-01-01'::timestamptz + g * interval '1 second'
      from generate_series(1, 1000) g`);
    await db.execute(sql`analyze entries; analyze topic_listing_stats`);
    for (const order of ["created", "activity", "insightful"] as const) {
      const all = await listTopics(db, { kind: "all" }, { order, limit: 100 });
      const actual = await listTopics(db, { kind: "all" }, { order, page: 8, limit: 10 });
      expect(actual.topics.map(row => row.id)).toEqual(all.topics.slice(70, 80).map(row => row.id));
      const last = seen.at(-1)!;
      if (order !== "created") {
        const shape = await plan(db, bind(last.query, last.params));
        expect(shape).toContain(order === "activity" ? "topic_listing_activity_idx" : "topic_listing_insightful_idx");
      }
    }
    const [place] = await db.insert(villages).values({ kind: "open", slug: "indexed-place" }).returning();
    await db.update(entries).set({ lang: "ja" }).where(sql`${entries.id} % 3 = 0`);
    await db.update(entries).set({ villageId: place.id }).where(sql`${entries.id} % 10 = 0`);
    await db.execute(sql`analyze entries; analyze topic_listing_stats`);
    for (const [scope, index] of [
      [{ kind: "langs", langs: ["ja"] }, "topic_listing_lang_activity_idx"],
      [{ kind: "village", villageId: place.id }, "topic_listing_village_activity_idx"],
    ] as const) {
      const result = await listTopics(db, scope, { order: "activity", page: 2, limit: 10 });
      const read = seen.at(-1)!;
      const shape = await plan(db, bind(read.query, read.params));
      expect(shape).toContain(index);
      expect(result.topics).toHaveLength(10);
    }
  });

  it("serializes site byte admission across members", async () => {
    const db = await createTestDb();
    for (const id of ["quota_one", "quota_two"]) await addMember(db, id, id);
    const results = await Promise.allSettled(["quota_one", "quota_two"].map(id => putMedia(db, id, { bytes: Buffer.alloc(16, id === "quota_one" ? 1 : 2), width: 1, height: 1 })));
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(row => row.status === "rejected").map(row => row.status === "rejected" && row.reason.code)).toEqual(["site_bytes"]);
    const result = await db.execute(sql`select sum(byte_size)::int as n from media where deleted_at is null`) as { rows: { n: number }[] };
    expect(result.rows[0].n).toBe(16);
  });

  it("supports handled moderation grouping and active image byte totals", async () => {
    const db = await createTestDb();
    await addMember(db, "cover_writer", "cover_writer");
    await addMember(db, "cover_reader", "cover_reader");
    await db.execute(sql`insert into entries(kind, author_id, lang, body)
      select 'topic', 'cover_writer', 'en', 'Post' from generate_series(1, 1000)`);
    await db.execute(sql`insert into reports(entry_id, reporter_id, reason, note, status)
      select id, 'cover_reader', 'spam', 'Fixture note', case when id % 2 = 0 then 'resolved' else 'open' end from entries where kind = 'topic'`);
    await db.execute(sql`insert into media(id, bytes, mime, width, height, byte_size, uploaded_by)
      select md5(g::text) || md5('image-' || g), decode('01', 'hex'), 'image/webp', 1, 1, 1, 'cover_writer' from generate_series(1, 100) g`);
    await db.execute(sql`vacuum (analyze) reports`);
    await db.execute(sql`vacuum (analyze) media`);
    await db.transaction(async tx => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const grouped = await plan(tx, sql`select entry_id, village_id, chat_message_id, min(created_at), max(handled_at)
        from reports where status <> 'open' group by entry_id, village_id, chat_message_id`);
      expect(grouped).toContain("reports_handled_group_idx");
      expect(await plan(tx, sql`select sum(byte_size) from media where deleted_at is null`)).toContain("media_active_bytes_idx");
    });
  });

  it("does not lose simultaneous votes on a topic", async () => {
    const db = await createTestDb();
    for (const id of ["parallel_writer", "parallel_one", "parallel_two"]) await addMember(db, id, id);
    const root = await topic(db, "parallel_writer");
    await Promise.all(["parallel_one", "parallel_two"].map(id => setVote(db, id, root.id, true)));
    expect((await db.select().from(topicListingStats))[0].insightfulCount).toBe(2);
    await Promise.all(["parallel_one", "parallel_two"].map(id => setVote(db, id, root.id, false)));
    expect((await db.select().from(topicListingStats))[0].insightfulCount).toBe(0);
  });

  it("recounts a vote only after a concurrent exclusion commits", async () => {
    const db = await createTestDb();
    await addMember(db, "counter_writer", "counter_writer");
    await addMember(db, "counter_voter", "counter_voter");
    const root = await topic(db, "counter_writer");
    const held = holdTx(db, async tx => {
      await tx.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "counter_voter"));
    });
    await held.ready;
    const pending = setVote(db, "counter_voter", root.id, true);
    try {
      await expect.poll(async () => {
        const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into "votes"%'`) as { rows: { n: number }[] };
        return rows.rows[0].n;
      }).toBeGreaterThan(0);
    } finally { await held.commit(); }
    expect(await pending).toMatchObject({ ok: true, changed: true });
    expect((await db.select().from(topicListingStats).where(eq(topicListingStats.topicId, root.id)))[0].insightfulCount).toBe(0);
    await db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "counter_voter"));
    expect((await db.select().from(topicListingStats).where(eq(topicListingStats.topicId, root.id)))[0].insightfulCount).toBe(1);
  });
});
