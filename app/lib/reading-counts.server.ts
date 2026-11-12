import { isEnabledLang } from "./enabled-langs.server";
const bucketLang = (lang: string): SourceLang => isEnabledLang(lang) ? lang : "other";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, profiles, readingCounts } from "./db/schema";
import type { Lang, SourceLang } from "./languages";
import { observationWeeks } from "./metrics.server";
import { publicTopicPlace } from "./visibility.server";
import { READING_METHODS, READING_SOURCES, type ReadingMethod, type ReadingSource } from "./reading-sources.server";

// Count only buckets. The topic and reader are used solely for eligibility and
// discarded before the write: no entry, person, device, IP, referrer or user
// agent is retained, and there is no per-read event or join back to a reader.
export async function countReading(db: Db, topicId: number, opts: {
  method: ReadingMethod; lang: SourceLang | (() => Promise<SourceLang>); source?: ReadingSource; readerId?: string | null; now?: Date;
}) {
  try {
    const [topic] = await db.select({ lang: entries.lang, authorId: entries.authorId }).from(entries)
      .where(and(eq(entries.id, topicId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
    if (!topic || opts.readerId === topic.authorId) return;
    if (opts.readerId) {
      const [reader] = await db.select({ excluded: profiles.reactionsExcludedAt }).from(profiles).where(eq(profiles.userId, opts.readerId));
      if (!reader || reader.excluded) return;
    }
    await db.insert(readingCounts).values({ day: (opts.now ?? new Date()).toISOString().slice(0, 10), method: opts.method,
      sourceLang: bucketLang(topic.lang), readLang: bucketLang(typeof opts.lang === "function" ? await opts.lang() : opts.lang), source: opts.method === "browser" ? opts.source ?? "none" : "none", count: 1 })
      .onConflictDoUpdate({ target: [readingCounts.day, readingCounts.method, readingCounts.sourceLang, readingCounts.readLang, readingCounts.source], set: { count: sql`${readingCounts.count} + 1` } });
  } catch {
    // Never attach the exception: database errors may contain identifying values.
    console.warn("[reading-counts] Could not count read");
  }
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
