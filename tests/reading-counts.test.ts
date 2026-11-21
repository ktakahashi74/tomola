import { getTableColumns, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { createTopic, softDeleteEntry } from "~/lib/entries.server";
import { PG_MODE } from "./helpers/pg-test";
import { formatArticleReadingDisplay } from "~/lib/article-reading";
import { entries, entryReadingCounts, entryReadingMetricState, profiles, readingCounts, villages } from "~/lib/db/schema";
import { articleReadingDisplay, articleReadingQuery, countReading, topArticleReadings, topArticleReadingsQuery, weeklyReadings } from "~/lib/reading-counts.server";

const translated = { sourceLang: "ja", readLang: "en", isTranslated: true } as const;
const original = { sourceLang: "ja", readLang: "ja", isTranslated: false } as const;

it("atomically increments only anonymous UTC buckets and never stores identifying fields", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_source", "reading_source");
  const topic = await createTopic(db, "reading_source", { lang: "ja", title: "Reading fixture", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  const opts = { method: "browser" as const, display: translated, source: "ai" as const, now: new Date("2026-11-12T23:30:00Z") };
  await Promise.all([countReading(db, topic.id, opts), countReading(db, topic.id, opts)]);
  const rows = await db.select().from(readingCounts).where(eq(readingCounts.source, "ai"));
  expect(rows).toEqual([{ day: "2026-11-12", method: "browser", sourceLang: "ja", readLang: "en", source: "ai", count: 2 }]);
  expect(Object.keys(getTableColumns(readingCounts)).sort()).toEqual(["count", "day", "method", "readLang", "source", "sourceLang"]);
  expect(await db.select().from(entryReadingCounts)).toEqual([{ entryId: topic.id, day: "2026-11-12", method: "browser", isTranslated: true, count: 2 }]);
  expect(Object.keys(getTableColumns(entryReadingCounts)).sort()).toEqual(["count", "day", "entryId", "isTranslated", "method"]);
  const weekly = await weeklyReadings(db, new Date("2026-11-13T00:00:00Z"));
  expect(weekly.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(weekly.weeks.at(-1)).toMatchObject({ observed: true, total: 2, translated: 2, pairs: [{ sourceLang: "ja", readLang: "en", count: 2 }] });
  expect(weekly.weeks[0].observed).toBe(false);
});
it("excludes authors, excluded members, hidden/deleted posts and closed villages", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_author", "reading_author");
  await addMember(db, "reading_excluded", "reading_excluded");
  await db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "reading_excluded"));
  const topic = await createTopic(db, "reading_author", { lang: "ja", title: "Private fixture", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  const opts = { method: "browser" as const, display: original };
  await countReading(db, topic.id, { ...opts, readerId: "reading_author" });
  await countReading(db, topic.id, { ...opts, readerId: "reading_excluded" });
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
  await countReading(db, topic.id, opts);
  await db.update(entries).set({ hiddenAt: null, deletedAt: new Date() }).where(eq(entries.id, topic.id));
  await countReading(db, topic.id, opts);
  const villageId = "1234567890abcdef1234567890abcdef";
  await db.insert(villages).values({ id: villageId, kind: "closed", name: "Closed", sourceLang: "ja" });
  await db.update(entries).set({ deletedAt: null, villageId }).where(eq(entries.id, topic.id));
  await countReading(db, topic.id, opts);
  expect((await db.select({ total: sql<number>`sum(${readingCounts.count})::int` }).from(readingCounts))[0].total).toBe(0);
});
it("keeps machine methods separate and aggregates them without creating event records", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_tools", "reading_tools");
  const topic = await createTopic(db, "reading_tools", { lang: "ja", title: "Tools", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  for (const method of ["markdown", "api", "mcp", "ai_crawler"] as const) await countReading(db, topic.id, { method, display: translated, source: "ai" });
  const rows = await db.select().from(readingCounts);
  expect(rows.filter(row => row.count > 0).map(row => [row.method, row.source, row.count]).sort()).toEqual([
    ["ai_crawler", "none", 1], ["api", "none", 1], ["markdown", "none", 1], ["mcp", "none", 1],
  ]);
});

it("contains failures in count-only language resolution without logging their details", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_failure", "reading_failure");
  const topic = await createTopic(db, "reading_failure", { lang: "ja", title: "Failure", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(countReading(db, topic.id, { method: "ai_crawler", display: async () => { throw new Error("private IP and user agent"); } })).resolves.toEqual({ counted: false });
    expect(warn.mock.calls).toEqual([["[reading-counts] Could not count read"]]);
    expect((await db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
  } finally { warn.mockRestore(); }
});

it("applies complementary suppression at the browser-view thresholds without rounding", () => {
  for (const [total, translated] of [[0, 0], [4, 0], [4, 4]]) expect(formatArticleReadingDisplay(total, translated)).toBeNull();
  for (const [total, translated] of [[5, 0], [5, 4], [6, 5], [9, 5], [42, 40], [42, 4]]) {
    expect(formatArticleReadingDisplay(total, translated)).toEqual({ total, translated: null });
  }
  for (const [total, translated] of [[5, 5], [10, 5], [42, 42], [42, 37]]) {
    expect(formatArticleReadingDisplay(total, translated)).toEqual({ total, translated });
  }
});

it("keeps the seeded timestamp after all article counts are removed and compares creation times within a UTC day", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_time", "reading_time");
  const [seed] = await db.select().from(entryReadingMetricState);
  expect(seed.startedAt).toBeInstanceOf(Date);
  const startedAt = new Date("2026-11-11T12:00:00Z");
  await db.update(entryReadingMetricState).set({ startedAt });
  const [before, at, after] = await db.insert(entries).values([
    new Date("2026-11-11T11:59:59Z"), startedAt, new Date("2026-11-11T12:00:01Z"),
  ].map(createdAt => ({ kind: "topic" as const, authorId: "reading_time", lang: "ja", body: "Reading fixture", createdAt }))).returning({ id: entries.id });
  await db.insert(entryReadingCounts).values([before, at, after].map(({ id }) => ({
    entryId: id, day: "2026-11-11", method: "browser" as const, isTranslated: false, count: 42,
  })));
  for (const [id, since] of [[before.id, "2026-11-11"], [at.id, null], [after.id, null]] as const) {
    expect(await articleReadingDisplay(db, id)).toEqual({ total: 42, translated: null, since });
  }
  await db.delete(entryReadingCounts);
  expect(await articleReadingDisplay(db, before.id)).toBeNull();
  expect(await db.select().from(entryReadingMetricState)).toEqual([{ id: 1, startedAt }]);
});

it("preserves the original-or-translated fact even when both site-wide languages share one bucket", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  try {
    const db = await createTestDb();
    await addMember(db, "reading_other", "reading_other");
    const [topic] = await db.insert(entries).values({ kind: "topic", authorId: "reading_other", lang: "other", body: "Other source." }).returning();
    expect(await countReading(db, topic.id, { method: "browser", display: { sourceLang: "other", readLang: "de", isTranslated: true } })).toEqual({ counted: true });
    await db.update(entries).set({ lang: "de" }).where(eq(entries.id, topic.id));
    expect(await countReading(db, topic.id, { method: "browser", display: { sourceLang: "de", readLang: "de", isTranslated: false } })).toEqual({ counted: true });
    expect((await db.select().from(readingCounts)).filter(row => row.count)).toEqual([
      { day: new Date().toISOString().slice(0, 10), method: "browser", sourceLang: "other", readLang: "other", source: "none", count: 2 },
    ]);
    expect((await db.select().from(entryReadingCounts)).map(row => row.isTranslated).sort()).toEqual([false, true]);
  } finally { vi.unstubAllEnvs(); }
});

it.skipIf(!PG_MODE).each(["author deletes", "moderator hides", "village becomes private"])(
  "checks visibility after a concurrent writer commits when the %s", { tags: ["postgres"] }, async change => {
    const db = await createTestDb();
    await addMember(db, "reading_race", "reading_race");
    const [village] = await db.insert(villages).values({ kind: "open", slug: "reading-race" }).returning();
    const [topic] = await db.insert(entries).values({
      kind: "topic", authorId: "reading_race", lang: "ja", body: "Reading fixture",
      villageId: village.id,
    }).returning();
    const opts = { method: "browser" as const, display: original };
    expect(await countReading(db, topic.id, opts)).toEqual({ counted: true });
    let changed!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { changed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = db.transaction(async tx => {
      if (change === "author deletes") await softDeleteEntry(tx, topic.id);
      else if (change === "moderator hides") await tx.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
      else await tx.update(villages).set({ kind: "closed" }).where(eq(villages.id, village.id));
      changed();
      await gate;
    });
    await Promise.race([inside, writer]);
    const reader = countReading(db, topic.id, opts);
    try {
      await expect.poll(async () => {
        const result = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`) as { rows: { waiting: number }[] };
        return result.rows[0].waiting;
      }).toBe(1);
      if (change !== "village becomes private") {
        // The waiting count must not keep a share lock on the village.
        await db.execute(sql`select id from ${villages} where id = ${village.id} for no key update nowait`);
      }
    } finally {
      release();
      await writer;
      await reader;
    }
    expect(await reader).toEqual({ counted: false });
    expect(await articleReadingDisplay(db, topic.id)).toBeNull();
    expect((await topArticleReadings(db, new Date())).articles).toEqual([]);
    expect((await db.select().from(readingCounts)).filter(row => row.count).map(row => row.count)).toEqual([1]);
    expect((await db.select().from(entryReadingCounts)).map(row => row.count)).toEqual(change === "author deletes" ? [] : [1]);
  },
);

it("excludes hidden, deleted, private, zero-count and out-of-window articles before ranking 50 rows", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_rank", "reading_rank");
  const [village] = await db.insert(villages).values({ kind: "closed" }).returning();
  const seed = { kind: "topic", authorId: "reading_rank", lang: "ja", body: "Headline from body." } as const;
  const now = new Date("2026-11-21T00:05:00Z");
  const [hidden, deleted, closed, old, future, zero, onlyTools, rankFirst, rankSecond, ...rest] = await db.insert(entries).values([
    { ...seed, hiddenAt: now }, { ...seed, deletedAt: now }, { ...seed, villageId: village.id },
    ...Array.from({ length: 56 }, () => seed),
  ]).returning();
  const day = "2026-10-23";
  const readings = (entryId: number, method: typeof entryReadingCounts.$inferInsert.method, count: number, date = day, isTranslated = false) => ({
    entryId, method, day: date, count, isTranslated,
  });
  await db.insert(entryReadingCounts).values([
    ...[hidden, deleted, closed].map(row => readings(row.id, "browser", 800)),
    readings(old.id, "browser", 800, "2026-10-22"), readings(future.id, "browser", 800, "2026-11-22"), readings(zero.id, "browser", 0),
    readings(rankFirst.id, "browser", 3, "2026-11-21", true), readings(rankFirst.id, "browser", 1), readings(rankFirst.id, "api", 4),
    readings(rankSecond.id, "browser", 4), readings(rankSecond.id, "mcp", 3),
    readings(onlyTools.id, "ai_crawler", 30),
    ...rest.map(row => readings(row.id, "browser", 1)),
  ]);
  const result = await topArticleReadings(db, now);
  expect(result).toMatchObject({ start: day, end: "2026-11-21" });
  expect(result.articles).toHaveLength(50);
  expect(result.articles[0]).toMatchObject({ id: rankFirst.id, title: "Headline from body.", browser: 4, translated: 3, api: 4 });
  expect(result.articles[1]).toMatchObject({ id: rankSecond.id, browser: 4, translated: 0, mcp: 3 });
  expect(result.articles.slice(2).map(row => row.id)).toEqual(rest.slice(-48).reverse().map(row => row.id));
});

it.skipIf(!PG_MODE)("uses the article and recent-day indexes with selective filters on real PostgreSQL", { tags: ["postgres"] }, async () => {
  const db = await createTestDb();
  await addMember(db, "reading_plan", "reading_plan");
  const topics = await db.insert(entries).values(Array.from({ length: 120 }, () => ({
    kind: "topic" as const, authorId: "reading_plan", lang: "ja", body: "Plan fixture.",
  }))).returning({ id: entries.id });
  await db.execute(sql`insert into ${entryReadingCounts} (entry_id, day, method, is_translated, count)
    select id, date '2026-11-21' - age, 'browser', false, 1
    from ${entries} cross join generate_series(0, 729) as age`);
  await db.execute(sql`analyze ${entryReadingCounts}`);
  for (const [query, index] of [
    [articleReadingQuery(db, topics[0].id), "entry_reading_counts_entry_id_day_method_is_translated_pk"],
    [topArticleReadingsQuery(db, "2026-10-23", "2026-11-21"), "entry_reading_counts_day_entry_idx"],
  ] as const) {
    const result = await db.execute(sql`explain (analyze, buffers) ${query.getSQL()}`) as { rows: { "QUERY PLAN": string }[] };
    const plan = result.rows.map(row => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/Seq Scan on entry_reading_counts/);
  }
});
