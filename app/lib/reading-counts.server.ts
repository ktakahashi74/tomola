import { isEnabledLang } from "./enabled-langs.server";
import { and, desc, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/client.server";
import { entries, entryReadingCounts, entryReadingMetricState, profiles, readingCounts, villages } from "./db/schema";
import type { SourceLang } from "./languages";
import { observationWeeks } from "./metrics.server";
import { publicTopicPlace } from "./visibility.server";
import { READING_METHODS, READING_SOURCES, type ReadingMethod, type ReadingSource } from "./reading-sources.server";
import { formatArticleReadingDisplay } from "./article-reading";
import { isDeletedIdentity } from "./deleted-member";
import { headlineFromBody } from "./headline.server";
import type { DisplayInput } from "./entry-display.server";
import type { ReadingDisplay } from "./reading-mark.server";

const bucketLang = (lang: string): SourceLang => isEnabledLang(lang) ? lang : "other";
const publicArticle = () => and(eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace());
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

const topicLockBusy = Symbol("topic reading lock busy");
const visibilityWriterFinished = Symbol("topic visibility writer finished");

async function waitForTopicWriter(db: Db, topicId: number) {
  // Roll back the wait savepoint so the lock also releases for a caller already in a transaction.
  try {
    await db.transaction(async tx => {
      await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, topicId)).for("share");
      throw visibilityWriterFinished;
    });
  } catch (error) {
    if (error !== visibilityWriterFinished) throw error;
  }
}

// The reader is used only for eligibility. Both counters store aggregates.
export async function countReading(db: Db, topicId: number, opts: {
  method: ReadingMethod;
  display: ReadingDisplay | ((tx: Tx, topic: DisplayInput) => Promise<ReadingDisplay>);
  source?: ReadingSource;
  readerId?: string | null;
  now?: Date;
}) {
  const write = () => db.transaction(async tx => {
    const [place] = await tx.select({ villageId: entries.villageId }).from(entries).where(eq(entries.id, topicId));
    if (!place) return false;
    // A fresh statement checks publicity after any village update has committed.
    // Posting can already hold a referenced topic when it locks the village.
    if (place.villageId !== null) {
      await tx.select({ id: villages.id }).from(villages).where(eq(villages.id, place.villageId)).for("share");
    }
    const [topic] = await tx.select({
      id: entries.id, lang: entries.lang, sourceHash: entries.sourceHash, authorId: entries.authorId, villageId: entries.villageId,
    }).from(entries).where(and(eq(entries.id, topicId), publicArticle())).for("share", place.villageId === null ? undefined : { noWait: true }).catch(error => {
      const cause: unknown = error instanceof Error ? error.cause : undefined;
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "55P03") throw topicLockBusy;
      throw error;
    });
    // SHARE conflicts with NO KEY UPDATE and remains compatible with other reads and reply FK checks.
    if (!topic || topic.villageId !== place.villageId) return false;

    const readerId = isDeletedIdentity(opts.readerId) ? null : opts.readerId;
    if (readerId) {
      if (readerId === topic.authorId) return false;
      const [reader] = await tx.select({ excluded: profiles.reactionsExcludedAt }).from(profiles).where(eq(profiles.userId, readerId));
      if (!reader || reader.excluded) return false;
    }

    const display = typeof opts.display === "function"
      ? await opts.display(tx, { ...topic, lang: topic.lang as SourceLang, kind: "topic" })
      : opts.display;
    const day = utcDay(opts.now ?? new Date());
    const { method } = opts;
    await tx.insert(readingCounts).values({
      day, method, sourceLang: bucketLang(display.sourceLang), readLang: bucketLang(display.readLang),
      source: method === "browser" ? opts.source ?? "none" : "none", count: 1,
    }).onConflictDoUpdate({
      target: [readingCounts.day, readingCounts.method, readingCounts.sourceLang, readingCounts.readLang, readingCounts.source],
      set: { count: sql`${readingCounts.count} + 1` },
    });
    await tx.insert(entryReadingCounts).values({ entryId: topicId, day, method, isTranslated: display.isTranslated, count: 1 })
      .onConflictDoUpdate({
        target: [entryReadingCounts.entryId, entryReadingCounts.day, entryReadingCounts.method, entryReadingCounts.isTranslated],
        set: { count: sql`${entryReadingCounts.count} + 1` },
      });
    return true;
  });
  try {
    try { return { counted: await write() }; }
    catch (error) {
      if (error !== topicLockBusy) throw error;
      // Wait without a village lock, then recheck both rows in a new write transaction.
      await waitForTopicWriter(db, topicId);
      return { counted: await write() };
    }
  } catch {
    // Never attach the exception: database errors may contain identifying values.
    console.warn("[reading-counts] Could not count read");
    return { counted: false };
  }
}

const browser = eq(entryReadingCounts.method, "browser");
const sumArticleReads = (filter = sql`true`) => sql<number>`coalesce(sum(${entryReadingCounts.count}) filter (where ${filter}), 0)`.mapWith(Number);
const metricStart = () => sql<Date>`(select ${entryReadingMetricState.startedAt} from ${entryReadingMetricState} where ${entryReadingMetricState.id} = 1)`.mapWith(entryReadingMetricState.startedAt);

export function articleReadingQuery(db: Db, topicId: number) {
  return db.select({
    total: sumArticleReads(),
    translated: sumArticleReads(sql`${entryReadingCounts.isTranslated}`),
    createdAt: entries.createdAt,
    startedAt: metricStart(),
  }).from(entryReadingCounts).innerJoin(entries, eq(entries.id, entryReadingCounts.entryId))
    .where(and(eq(entryReadingCounts.entryId, topicId), browser, publicArticle())).groupBy(entries.id);
}

export async function articleReadingDisplay(db: Db, topicId: number) {
  const [row] = await articleReadingQuery(db, topicId);
  if (!row) return null;
  const display = formatArticleReadingDisplay(row.total, row.translated);
  return display && { ...display, since: row.startedAt && row.createdAt < row.startedAt ? utcDay(row.startedAt) : null };
}

export function topArticleReadingsQuery(db: Db, start: string, end: string) {
  const methodTotal = (method: ReadingMethod) => sumArticleReads(eq(entryReadingCounts.method, method));
  const counted = db.select({
    entryId: entryReadingCounts.entryId,
    total: sumArticleReads().as("total"),
    browser: sumArticleReads(browser).as("browser"),
    translated: sumArticleReads(sql`${browser} and ${entryReadingCounts.isTranslated}`).as("translated"),
    markdown: methodTotal("markdown").as("markdown"),
    api: methodTotal("api").as("api"),
    mcp: methodTotal("mcp").as("mcp"),
    crawler: methodTotal("ai_crawler").as("crawler"),
  }).from(entryReadingCounts)
    .where(and(gte(entryReadingCounts.day, start), lte(entryReadingCounts.day, end), gt(entryReadingCounts.count, 0)))
    .groupBy(entryReadingCounts.entryId).as("recent");
  return db.select({
    id: entries.id, title: entries.title,
    body: sql<string | null>`case when ${entries.title} is null then left(${entries.body}, 1024) end`,
    browser: counted.browser, translated: counted.translated, markdown: counted.markdown,
    api: counted.api, mcp: counted.mcp, crawler: counted.crawler,
  }).from(counted).innerJoin(entries, eq(entries.id, counted.entryId)).where(publicArticle())
    .orderBy(desc(counted.browser), desc(counted.total), desc(entries.id)).limit(50);
}

export async function topArticleReadings(db: Db, now: Date) {
  const start = utcDay(new Date(now.getTime() - 29 * 86400_000));
  const end = utcDay(now);
  const [rows, [state]] = await Promise.all([
    topArticleReadingsQuery(db, start, end), db.select().from(entryReadingMetricState),
  ]);
  const articles = await Promise.all(rows.map(async ({ title, body, ...row }) => ({
    ...row, title: title ?? await headlineFromBody(body ?? ""),
  })));
  return { start, end, startedAt: state?.startedAt ?? null, articles };
}

const sumReadingCounts = (filter = sql`true`) => sql<number>`coalesce(sum(${readingCounts.count}) filter (where ${filter}), 0)`.mapWith(Number);

export async function cumulativeReadings(db: Db, now: Date) {
  const buckets = await db.select({
    method: readingCounts.method, source: readingCounts.source, count: sumReadingCounts(),
    translated: sumReadingCounts(sql`${readingCounts.sourceLang} <> ${readingCounts.readLang}`),
  }).from(readingCounts).where(and(lte(readingCounts.day, utcDay(now)), gt(readingCounts.count, 0)))
    .groupBy(readingCounts.method, readingCounts.source);
  const browser = buckets.filter(bucket => bucket.method === "browser");
  return {
    total: browser.reduce((sum, bucket) => sum + bucket.count, 0),
    translated: browser.reduce((sum, bucket) => sum + bucket.translated, 0),
    sources: READING_SOURCES.map(source => ({
      source, count: browser.find(bucket => bucket.source === source)?.count ?? 0,
    })),
    methods: READING_METHODS.filter(method => method !== "browser").map(method => ({
      method, count: buckets.find(bucket => bucket.method === method)?.count ?? 0,
    })),
  };
}

export async function weeklyReadings(db: Db, now: Date) {
  const starts = observationWeeks(now);
  // The migration creates one zero bucket to retain the UTC measurement start
  // even when nobody reads. It never contributes a read or a language pair.
  const [state] = await db.select({ since: sql<string | null>`min(${readingCounts.day})::text` }).from(readingCounts);
  const since: string | null = state?.since ?? null;
  const rows = await db.select().from(readingCounts).where(and(gte(readingCounts.day, starts[0].toISOString().slice(0, 10)), lte(readingCounts.day, now.toISOString().slice(0, 10))));
  return { since, weeks: starts.map(start => {
    const week = start.toISOString().slice(0, 10);
    const end = new Date(start.getTime() + 7 * 86400_000).toISOString().slice(0, 10);
    const buckets = rows.filter(row => row.day >= week && row.day < end && row.count > 0);
    const browser = buckets.filter(row => row.method === "browser");
    const total = browser.reduce((sum, row) => sum + row.count, 0);
    const pairs = new Map<string, { sourceLang: string; readLang: string; count: number }>();
    for (const row of buckets) {
      const key = `${row.sourceLang}:${row.readLang}`;
      const pair = pairs.get(key) ?? { sourceLang: row.sourceLang, readLang: row.readLang, count: 0 };
      pair.count += row.count; pairs.set(key, pair);
    }
    return { week, observed: since !== null && since < end, total,
      translated: browser.filter(row => row.sourceLang !== row.readLang).reduce((sum, row) => sum + row.count, 0),
      sources: READING_SOURCES.map(source => ({ source, count: browser.filter(row => row.source === source).reduce((sum, row) => sum + row.count, 0) })),
      methods: READING_METHODS.filter(method => method !== "browser").map(method => ({ method, count: buckets.filter(row => row.method === method).reduce((sum, row) => sum + row.count, 0) })),
      pairs: [...pairs.values()].sort((a, b) => a.sourceLang.localeCompare(b.sourceLang) || a.readLang.localeCompare(b.readLang)),
    };
  }) };
}
