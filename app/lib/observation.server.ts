import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { AI_ASSISTANCE, type AiAssistance } from "~/lib/ai-assistance";
import type { Db } from "~/lib/db/client.server";
import { accountDeletions, divergences, entries, entryEmbeddings, translations } from "~/lib/db/schema";
import { AREAS, LANGS, type Area, type Lang } from "~/lib/languages";
import { FLAG_JUDGED } from "~/lib/llm/flags";
import { sameVendor } from "~/lib/llm/vendor";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import { SEVERITIES, type Severity } from "~/lib/llm/types";
import { CONFORMITY_DECLINES, MIN_DIVERSITY_ENTRIES, OBSERVATION_MONTHS } from "~/lib/observation";

// Observations for /admin/observation and /admin/export.
// Every metric excludes unreadable posts: deleted/hidden or replies to deleted/hidden topics (visibility.server.ts). Count posting-time author_area, omitting authors without profiles.
// Months use UTC.

export { CONFORMITY_DECLINES, MIN_DIVERSITY_ENTRIES, OBSERVATION_MONTHS };

const emptySeverity = (): Record<Severity, number> => ({ low: 0, medium: 0, high: 0 });

// ---- 1. Divergence ----

// tone counts category:tone records (hedge became assertion or vice versa). Meaning divergence is records-tone.
export type DivergenceCounts = { measured: number; records: number; tone: number; severity: Record<Severity, number> };
export type DivergencePair = DivergenceCounts & {
  // Original and target languages.
  from: Lang;
  to: Lang;
  // Eligible translations: current-source primary topic-body translations, excluding fallback with no comparison counterpart. measured counts eligible translations selected and judged
  // by DIVERGENCE_SAMPLE_RATE (divergence-sample.server.ts). measured/eligible is that language pair's compared fraction.
  eligible: number;
  // Of these, comparisons whose secondary model shares the primary provider, identified from engine names via vendor.ts. Report separately since they are not independent.
  sameVendor: DivergenceCounts;
};

const addTo = (c: DivergenceCounts, field: "measured" | "records", n: number, severity?: Severity) => {
  c[field] += n;
  if (field === "records" && severity) c.severity[severity] += n;
};
const emptyCounts = (): DivergenceCounts => ({ measured: 0, records: 0, tone: 0, severity: emptySeverity() });

// Per original/target-language pair: measured body translations, divergence records, severity low/medium/high counts, and same-provider-secondary counts separately.
// measured requires secondary body translation with judged flag, including no-divergence measurements.
export async function divergenceStats(db: Db): Promise<DivergencePair[]> {
  const secondary = alias(translations, "secondary");
  const primary = alias(translations, "primary");
  const visible = visibleWithTopic();
  const [measuredRows, recordRows, eligibleRows] = await Promise.all([
    db
      .select({ from: entries.lang, to: secondary.lang, primaryEngine: primary.engine, secondaryEngine: secondary.engine, n: sql<number>`count(*)::int` })
      .from(secondary)
      .innerJoin(entries, eq(entries.id, secondary.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .leftJoin(primary, and(eq(primary.entryId, secondary.entryId), eq(primary.lang, secondary.lang), eq(primary.field, "body"), eq(primary.kind, "primary")))
      // Current-version translations only. Exclude measurements made before source edits, using the same counting rule as eligible translations so 「測った / 比べられる」 cannot exceed 100%.
      .where(
        and(
          visible,
          eq(secondary.kind, "secondary"),
          eq(secondary.field, "body"),
          sql`${FLAG_JUDGED} = any(${secondary.flags})`,
          eq(secondary.sourceHash, entries.sourceHash),
          eq(primary.sourceHash, entries.sourceHash),
          eq(primary.fallback, false),
        ),
      )
      .groupBy(entries.lang, secondary.lang, primary.engine, secondary.engine),
    db
      .select({
        from: entries.lang,
        to: divergences.lang,
        severity: divergences.severity,
        category: divergences.category,
        primaryEngine: primary.engine,
        secondaryEngine: secondary.engine,
        n: sql<number>`count(*)::int`,
      })
      .from(divergences)
      .innerJoin(entries, eq(entries.id, divergences.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .leftJoin(secondary, and(eq(secondary.entryId, divergences.entryId), eq(secondary.lang, divergences.lang), eq(secondary.field, "body"), eq(secondary.kind, "secondary")))
      .leftJoin(primary, and(eq(primary.entryId, divergences.entryId), eq(primary.lang, divergences.lang), eq(primary.field, "body"), eq(primary.kind, "primary")))
      .where(and(visible, or(isNull(divergences.sourceHash), eq(divergences.sourceHash, entries.sourceHash))))
      .groupBy(entries.lang, divergences.lang, divergences.severity, divergences.category, primary.engine, secondary.engine),
    db
      .select({ from: entries.lang, to: primary.lang, n: sql<number>`count(*)::int` })
      .from(primary)
      .innerJoin(entries, eq(entries.id, primary.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .where(and(visible, eq(entries.kind, "topic"), eq(primary.kind, "primary"), eq(primary.field, "body"), eq(primary.fallback, false), eq(primary.sourceHash, entries.sourceHash)))
      .groupBy(entries.lang, primary.lang),
  ]);
  const pairs = new Map<string, DivergencePair>();
  const pairOf = (from: string, to: string) => {
    const key = `${from}>${to}`;
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { from: from as Lang, to: to as Lang, eligible: 0, ...emptyCounts(), sameVendor: emptyCounts() }));
    return pair;
  };
  // Show eligible pairs even with no measured translations: 「0 / N」 reveals disabled detection or rate 0.
  for (const r of eligibleRows) pairOf(r.from, r.to).eligible = Number(r.n);
  for (const r of measuredRows) {
    const pair = pairOf(r.from, r.to);
    addTo(pair, "measured", Number(r.n));
    if (sameVendor(r.primaryEngine, r.secondaryEngine) === true) addTo(pair.sameVendor, "measured", Number(r.n));
  }
  for (const r of recordRows) {
    const severity = (SEVERITIES as readonly string[]).includes(r.severity) ? (r.severity as Severity) : undefined;
    if (!severity) continue;
    const pair = pairOf(r.from, r.to);
    addTo(pair, "records", Number(r.n), severity);
    if (r.category === "tone") pair.tone += Number(r.n);
    if (sameVendor(r.primaryEngine, r.secondaryEngine) === true) {
      addTo(pair.sameVendor, "records", Number(r.n), severity);
      if (r.category === "tone") pair.sameVendor.tone += Number(r.n);
    }
  }
  const order = (l: string) => LANGS.indexOf(l as Lang);
  return [...pairs.values()].sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to));
}

// ---- 2. Post diversity ----

export type DiversityPoint = { area: Area; month: string; entries: number; meanDistance: number };

// Previous calendar month from YYYY-MM.
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// Start of the recent months window in UTC, including current month.
export function monthsStart(now: Date, months: number = OBSERVATION_MONTHS): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}

// Mean pairwise cosine distance of each area's post embeddings in each month.
// For normalized vectors v_i, sum S and count n, mean pairwise similarity is (|S|² − n) / (n (n − 1)); distance is 1 minus this.
// Aggregate sum/norm in DB via pgvector sum/vector_norm, one row per area/month, in linear time without constructing n² pairs
// or transferring 768-number embeddings to the app; no sampling needed. Use only current-model rows. Omit months with fewer than MIN_DIVERSITY_ENTRIES posts.
export async function diversityByAreaMonth(db: Db, opts: { model: string; now?: Date; months?: number }): Promise<DiversityPoint[]> {
  const since = monthsStart(opts.now ?? new Date(), opts.months);
  const month = sql<string>`to_char(${entries.createdAt} at time zone 'UTC', 'YYYY-MM')`;
  const rows = await db
    .select({
      area: entries.authorArea,
      month,
      n: sql<number>`count(*)::int`,
      norm: sql<number>`vector_norm(sum(l2_normalize(${entryEmbeddings.embedding})))::float8`,
    })
    .from(entryEmbeddings)
    .innerJoin(entries, eq(entries.id, entryEmbeddings.entryId))
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entryEmbeddings.model, opts.model), visibleWithTopic(), isNotNull(entries.authorArea), gte(entries.createdAt, since)))
    .groupBy(entries.authorArea, month)
    .having(sql`count(*) >= ${MIN_DIVERSITY_ENTRIES}`);
  const areaIndex = (a: string) => AREAS.indexOf(a as Area);
  return rows
    .map((r) => {
      const n = Number(r.n);
      const meanSimilarity = (Number(r.norm) ** 2 - n) / (n * (n - 1));
      return { area: r.area as Area, month: r.month, entries: n, meanDistance: 1 - meanSimilarity };
    })
    .filter((p) => Number.isFinite(p.meanDistance))
    .sort((a, b) => areaIndex(a.area) - areaIndex(b.area) || (a.month < b.month ? -1 : 1));
}

export type ConformityWarning = { area: Area; months: string[]; values: number[] };

// UTC month of a timestamp, YYYY-MM.
export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);

// 「同調の兆し」: for an area, CONFORMITY_DECLINES+1 consecutive months ending with the latest **completed month** have strictly decreasing diversity.
// Exclude current month: incomplete/small early samples vary. Series must end at the latest completed month, the previous month;
// if fewer than five posts leave no point there, do not warn. Missing sparse months break continuity.
export function conformityWarnings(points: readonly DiversityPoint[], now: Date): ConformityWarning[] {
  const current = monthOf(now);
  const lastCompleted = previousMonth(current);
  const warnings: ConformityWarning[] = [];
  for (const area of AREAS) {
    const series = points.filter((p) => p.area === area && p.month < current).sort((a, b) => (a.month < b.month ? -1 : 1));
    const tail = series.slice(-(CONFORMITY_DECLINES + 1));
    if (tail.length < CONFORMITY_DECLINES + 1 || tail[tail.length - 1].month !== lastCompleted) continue;
    const consecutive = tail.every((p, i) => i === 0 || previousMonth(p.month) === tail[i - 1].month);
    const declining = tail.every((p, i) => i === 0 || p.meanDistance < tail[i - 1].meanDistance);
    if (consecutive && declining) warnings.push({ area, months: tail.map((p) => p.month), values: tail.map((p) => p.meanDistance) });
  }
  return warnings;
}

// ---- 3. ai_assistance records ----

export type AiAssistancePoint = {
  area: Area;
  month: string;
  // counts and total cover only the posts that state a value (frontmatter or the API; posts written on screen state none). unstated: posts without one (not in total).
  counts: Record<AiAssistance, number>;
  total: number;
  unstated: number;
  // Non-none fraction among stated values; null if no stated posts.
  declaredShare: number | null;
};

// Per area/month ai_assistance counts (none,polish,draft,coauthor) and non-none fraction among stated posts. Count missing values separately as unstated. Use creation month.
export async function aiAssistanceByAreaMonth(db: Db, opts: { now?: Date; months?: number } = {}): Promise<AiAssistancePoint[]> {
  const since = monthsStart(opts.now ?? new Date(), opts.months);
  const month = sql<string>`to_char(${entries.createdAt} at time zone 'UTC', 'YYYY-MM')`;
  const rows = await db
    .select({ area: entries.authorArea, month, level: entries.aiAssistance, n: sql<number>`count(*)::int` })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(visibleWithTopic(), isNotNull(entries.authorArea), gte(entries.createdAt, since), inArray(entries.kind, ["topic", "reply"])))
    .groupBy(entries.authorArea, month, entries.aiAssistance);
  const cells = new Map<string, AiAssistancePoint>();
  for (const r of rows) {
    if (r.level !== null && !(AI_ASSISTANCE as readonly string[]).includes(r.level)) continue;
    const key = `${r.area}|${r.month}`;
    let cell = cells.get(key);
    if (!cell) {
      const counts = Object.fromEntries(AI_ASSISTANCE.map((l) => [l, 0])) as Record<AiAssistance, number>;
      cells.set(key, (cell = { area: r.area as Area, month: r.month, counts, total: 0, unstated: 0, declaredShare: null }));
    }
    if (r.level === null) {
      cell.unstated += Number(r.n);
      continue;
    }
    cell.counts[r.level as AiAssistance] += Number(r.n);
    cell.total += Number(r.n);
  }
  const areaIndex = (a: string) => AREAS.indexOf(a as Area);
  return [...cells.values()]
    .map((c) => ({ ...c, declaredShare: c.total > 0 ? (c.total - c.counts.none) / c.total : null }))
    .sort((a, b) => areaIndex(a.area) - areaIndex(b.area) || (a.month < b.month ? -1 : 1));
}

// ---- Summary ----

export type Observation = {
  accountsDeleted: number;
  now: Date;
  // Embedding model used for diversity, or null if absent.
  model: string | null;
  divergence: DivergencePair[];
  diversity: DiversityPoint[];
  conformity: ConformityWarning[];
  aiAssistance: AiAssistancePoint[];
};

export async function getObservation(db: Db, opts: { model: string | null; now?: Date }): Promise<Observation> {
  const now = opts.now ?? new Date();
  const [divergence, diversity, aiAssistance] = await Promise.all([
    divergenceStats(db),
    opts.model ? diversityByAreaMonth(db, { model: opts.model, now }) : Promise.resolve<DiversityPoint[]>([]),
    aiAssistanceByAreaMonth(db, { now }),
  ]);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(accountDeletions).where(eq(accountDeletions.state, "completed"));
  return { now, model: opts.model, divergence, diversity, conformity: conformityWarnings(diversity, now), aiAssistance, accountsDeleted: total };
}
