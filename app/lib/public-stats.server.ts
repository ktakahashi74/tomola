import { weeklyReadings } from "./reading-counts.server";
import type { Db } from "~/lib/db/client.server";
import { evaluationHistory } from "~/lib/eval/metrics.server";
import { translationInventory, translationQualitySignals } from "~/lib/eval/signals.server";
import { crossAreaInsightfulRate, crossAreaReplyRate, fourWeekRetention, observationWeeks, reportStats, weeklyActiveMembers } from "~/lib/metrics.server";

export const PUBLIC_STATS_TTL_MS = 60 * 60 * 1000;

// Only these selected values may leave the server. Never serialize operator
// metrics and rely on a component to hide fields.
export function publicCount(value: number): number | null {
  return value > 0 && value < 5 ? null : value;
}

export function publicRate(numerator: number, denominator: number, people?: number) {
  return {
    numerator: publicCount(numerator), denominator: publicCount(denominator),
    rate: denominator >= 5 && (numerator === 0 || numerator >= 5) ? numerator / denominator : null,
    ...(people === undefined ? {} : { people: publicCount(people) }),
  };
}

export async function collectPublicStats(db: Db, now: Date) {
  const starts = observationWeeks(now);
  const [history, inventory, replies, insightful, active, retention, reports, reading] = await Promise.all([
    evaluationHistory(db, { publicOnly: true }), translationInventory(db, now),
    crossAreaReplyRate(db, now), crossAreaInsightfulRate(db, now), weeklyActiveMembers(db, now), fourWeekRetention(db, now),
    Promise.all(starts.map(async from => {
      const to = new Date(Math.min(from.getTime() + 7 * 86400_000, now.getTime()));
      const [reports, signals] = await Promise.all([reportStats(db, { from, to }), translationQualitySignals(db, { from, to })]);
      // Corrections have a narrower denominator than the all-post report count:
      // post/chat reports with a known source language since measurement began.
      return { weekStart: from, total: reports.total,
        eligible: signals.translations.reduce((n, row) => n + row.reports, 0),
        corrected: signals.translations.reduce((n, row) => n + row.corrected, 0), since: signals.since };
    })),
    weeklyReadings(db, now),
  ]);
  return selectPublicStats({ now, history, inventory, replies, insightful, active, retention, reports, reading });
}

type Collected = {
  reading: Awaited<ReturnType<typeof weeklyReadings>>;
  now: Date;
  history: Awaited<ReturnType<typeof evaluationHistory>>;
  inventory: Awaited<ReturnType<typeof translationInventory>>;
  replies: Awaited<ReturnType<typeof crossAreaReplyRate>>;
  insightful: Awaited<ReturnType<typeof crossAreaInsightfulRate>>;
  active: Awaited<ReturnType<typeof weeklyActiveMembers>>;
  retention: Awaited<ReturnType<typeof fourWeekRetention>>;
  reports: Array<{ weekStart: Date; total: number; eligible: number; corrected: number; since: string }>;
};
const day = (at: Date) => at.toISOString().slice(0, 10);

export function selectPublicStats(source: Collected) {
  const run = source.history.find(run => run.status === "completed" && !run.fake);
  const groups = (rows: NonNullable<typeof run>["pairs"]) => rows.map(row => ({
    label: row.label, preserved: row.preserved, total: row.total, severe: row.severe, rate: row.rate,
  }));
  return {
    reading: { since: source.reading.since, weeks: source.reading.weeks.map(row => ({
      week: row.week, observed: row.observed, count: publicCount(row.total), translated: publicRate(row.translated, row.total),
      sources: row.sources.map(item => ({ source: item.source, ...publicRate(item.count, row.total) })),
      methods: row.methods.map(item => ({ method: item.method, count: publicCount(item.count) })),
    })) },
    generatedAt: source.now.toISOString(),
    currentWeek: day(observationWeeks(source.now, 1)[0]),
    evaluation: run ? {
      finishedAt: run.finishedAt, setVersion: run.setVersion,
      translator: { provider: run.translator.provider, model: run.translator.model },
      judge: { provider: run.judge.provider, model: run.judge.model },
      sameProvider: run.sameProvider, configurationChanged: run.configurationChanged,
      pairs: groups(run.pairs), categories: groups(run.categories),
    } : null,
    translations: source.inventory.weekly.map(row => ({ week: day(row.weekStart), count: publicCount(row.count) })),
    languagePairs: { count: publicCount(source.inventory.pairs), from: source.inventory.pairsFrom },
    reports: source.reports.map(row => ({ week: day(row.weekStart), count: publicCount(row.total),
      correction: publicRate(row.corrected, row.eligible), since: row.since })),
    replies: source.replies.map(row => ({ week: day(row.weekStart), ...publicRate(row.crossArea, row.topics, row.people) })),
    insightful: source.insightful.map(row => ({ week: day(row.weekStart), ...publicRate(row.numerator, row.denominator, row.people) })),
    active: source.active.map(row => ({ week: day(row.weekStart), count: publicCount(row.members) })),
    retention: source.retention.map(row => ({ week: day(row.cohortWeek), observed: row.observed, ...publicRate(row.numerator, row.denominator, row.people) })),
  };
}

export type PublicStats = ReturnType<typeof selectPublicStats>;

// Keyed by database to avoid mixing instances. Authentication always runs
// before this cache, even when a snapshot is already available.
export function createPublicStatsReader(collect = collectPublicStats, clock = Date.now) {
  const cache = new WeakMap<Db, { expires: number; pending: Promise<PublicStats> }>();
  return (db: Db): Promise<PublicStats> => {
    const existing = cache.get(db);
    if (existing && existing.expires > clock()) return existing.pending;
    const entry = { expires: Infinity, pending: Promise.resolve().then(() => collect(db, new Date(clock()))) };
    cache.set(db, entry);
    entry.pending = entry.pending.then(snapshot => {
      entry.expires = clock() + PUBLIC_STATS_TTL_MS;
      return snapshot;
    }, error => {
      cache.delete(db);
      throw error;
    });
    return entry.pending;
  };
}

export const readPublicStats = createPublicStatsReader();
