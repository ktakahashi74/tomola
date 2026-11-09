import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { entries, profiles, topicListingStats, user, votes } from "~/lib/db/schema";
import { createTopic, listTopics } from "~/lib/entries.server";
import { withEntryRender } from "~/lib/entry-render-preparation.server";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { holdTx } from "./helpers/pg-concurrency";

function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.unstubAllEnvs());
async function world() {
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  for (const id of ["race_author", "race_voter", "race_excluded"]) await addMember(db, id, id);
  const topics = await db.insert(entries).values([0, 1].map(n => ({ kind: "topic", authorId: "race_author", lang: "en", title: `Question ${n}`, body: "Question", asksStance: true }))).returning();
  return { db, topics };
}

describe.skipIf(!PG_MODE)("listing maintenance lock ordering", { tags: ["postgres"] }, () => {
  it("finishes a vote while the same member creates an alternative question", async () => {
    vi.stubEnv("VILLAGES", "1");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5173");
    const { db, topics: [question] } = await world();
    const locked = signal(), proceed = signal();
    const creating = withEntryRender(db, { kind: "topic", body: "Alternative", lang: "en" }, () => db.transaction(async tx => {
      await tx.select().from(profiles).where(eq(profiles.userId, "race_voter")).for("update");
      locked.resolve(); await proceed.promise;
      return createTopic(tx, "race_voter", { title: "Another question", body: "Alternative", lang: "en", village: "ja", asksStance: true, altOf: question.id });
    }), "race_voter");
    const creation = Promise.allSettled([creating]);
    void creating.catch(() => locked.resolve());
    await locked.promise;
    let voteDone = false;
    const voting = setVote(db, "race_voter", question.id, true).finally(() => { voteDone = true; });
    const voted = Promise.allSettled([voting]);
    try {
      await expect.poll(async () => {
        if (voteDone) return true;
        const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into "votes"%'`) as { rows: { n: number }[] };
        return result.rows[0].n > 0;
      }).toBe(true);
    } finally { proceed.resolve(); }
    const [made] = await creation, [pressed] = await voted;
    expect(made, made.status === "rejected" ? String(made.reason?.cause ?? made.reason) : JSON.stringify(made)).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(pressed, pressed.status === "rejected" ? String(pressed.reason?.cause ?? pressed.reason) : "vote").toMatchObject({ status: "fulfilled", value: { ok: true } });
    if (made.status === "fulfilled") expect(made.value).toMatchObject({ ok: true });
    if (pressed.status === "fulfilled") expect(pressed.value).toMatchObject({ ok: true, changed: true });
    expect((await db.select().from(topicListingStats).where(eq(topicListingStats.topicId, question.id)))[0].insightfulCount).toBe(1);
    vi.unstubAllEnvs();
  });

  it("locks affected topic totals in order when deleting a member's votes in reverse insertion order", async () => {
    const { db, topics } = await world();
    for (const topic of [...topics].reverse()) await setVote(db, "race_voter", topic.id, true);
    await db.execute(sql`create table listing_lock_order (sequence bigint generated always as identity, topic_id bigint unique);
      create function record_listing_lock() returns trigger language plpgsql as $$ begin
        insert into listing_lock_order(topic_id) values (NEW.topic_id) on conflict do nothing; return NEW;
      end $$;
      create trigger record_listing_lock before update on topic_listing_stats for each row execute function record_listing_lock()`);
    await db.delete(votes).where(eq(votes.voterId, "race_voter"));
    const recorded = await db.execute(sql`select topic_id::int as id from listing_lock_order order by sequence`) as { rows: { id: number }[] };
    expect(recorded.rows.map(row => row.id)).toEqual(topics.map(topic => topic.id).sort((a, b) => a - b));
  });

  it("keeps cascade deletion and simultaneous reaction exclusion consistent", async () => {
    const { db, topics } = await world();
    for (const voter of ["race_voter", "race_excluded"]) for (const topic of [...topics].reverse()) await setVote(db, voter, topic.id, true);
    const held = holdTx(db, tx => tx.select().from(topicListingStats).where(eq(topicListingStats.topicId, topics[0].id)).for("update"));
    await held.ready;
    const excluding = Promise.allSettled([db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "race_excluded"))]);
    const waiting = async () => Number((await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`) as { rows: { n: number }[] }).rows[0].n);
    let retiring: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await expect.poll(waiting).toBeGreaterThanOrEqual(1);
      retiring = Promise.allSettled([db.delete(user).where(eq(user.id, "race_voter"))]);
      await expect.poll(waiting).toBeGreaterThanOrEqual(2);
    } finally { await held.commit(); }
    const outcomes = [...await excluding, ...await retiring!];
    expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(topicListingStats)).map(row => row.insightfulCount)).toEqual([0, 0]);
  });

  it("preserves a vote that waits until a listing repair commits", async () => {
    const { rebuildTopicListingStats } = await import("~/lib/topic-listing-stats.server");
    const { db, topics: [question] } = await world();
    const held = holdTx(db, tx => rebuildTopicListingStats(tx, { write: true }));
    await held.ready;
    const pending = setVote(db, "race_voter", question.id, true);
    try {
      await expect.poll(async () => Number((await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into "votes"%'`) as { rows: { n: number }[] }).rows[0].n)).toBeGreaterThan(0);
    } finally { await held.commit(); }
    expect(await pending).toMatchObject({ ok: true, changed: true });
    expect((await db.select().from(topicListingStats).where(eq(topicListingStats.topicId, question.id)))[0].insightfulCount).toBe(1);
  });

  it("uses a question-only activity index and preserves the ordering of deep question pages", async () => {
    const seen: { query: string; params: unknown[] }[] = [];
    const db = await createTestDb({ logger: { logQuery(query, params) { seen.push({ query, params }); } } });
    await addMember(db, "index_writer", "index_writer");
    await db.execute(sql`insert into entries(kind, author_id, lang, title, body, asks_stance, created_at, last_activity_at)
      select 'topic', 'index_writer', 'en', 'Title', 'Body', n % 100 = 0,
        '2030-01-01'::timestamptz + n * interval '1 second', '2030-01-01'::timestamptz + (10000-n) * interval '1 second'
      from generate_series(1, 10000) n`);
    await db.execute(sql`analyze entries; analyze topic_listing_stats`);
    const all = await listTopics(db, { kind: "all" }, { order: "activity", asksOnly: true, limit: 100 });
    const page = await listTopics(db, { kind: "all" }, { order: "activity", asksOnly: true, limit: 10, page: 5 });
    expect(page.topics.map(topic => topic.id)).toEqual(all.topics.slice(40, 50).map(topic => topic.id));
    const query = seen.at(-1)!;
    const statement = sql.empty(); let last = 0;
    for (const match of query.query.matchAll(/\$(\d+)/g)) { statement.append(sql.raw(query.query.slice(last, match.index))); statement.append(sql`${query.params[Number(match[1]) - 1]}`); last = match.index! + match[0].length; }
    statement.append(sql.raw(query.query.slice(last)));
    const explained = await db.execute(sql`explain (analyze, buffers, format json) ${statement}`) as { rows: { "QUERY PLAN": unknown }[] };
    expect(JSON.stringify(explained.rows[0]["QUERY PLAN"])).toContain("topic_listing_question_activity_idx");
  });
});
