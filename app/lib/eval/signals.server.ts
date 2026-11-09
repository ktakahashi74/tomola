import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { aiDraftEdits, chatMessages, chatMessageTranslations, chatTranslationReports, qualityMetricState, translationReports, translations, translationSignalCounts, villages } from "~/lib/db/schema";
import { observationWeeks, weekStartOf } from "~/lib/metrics.server";
import { HIDDEN_PRIMARY_FLAGS, NEAR_COPY_FLAGS } from "~/lib/llm/flags";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import { chatVillageCondition } from "~/lib/village-chat-villages.server";
import { entries } from "~/lib/db/schema";

// Call only with the transaction that commits a generated, primary translation.
// The counters survive later source edits/deletions and contain no identifiers.
export async function recordTranslationGeneration(db: Db, scope: "post" | "chat", from: string, to: string) {
  await db.insert(translationSignalCounts).values({ scope, from, to, generated: 1 }).onConflictDoUpdate({ target: [translationSignalCounts.scope, translationSignalCounts.from, translationSignalCounts.to], set: { generated: sql`${translationSignalCounts.generated} + 1` } });
}

// The lifetime counters have no timestamps. This inventory counts surviving
// primary translation records by their first creation, not regeneration calls.
export async function translationInventory(db: Db, now: Date, weeks = 8) {
  const starts = observationWeeks(now, weeks);
  const excludedFlags = sql`array[${sql.join([...HIDDEN_PRIMARY_FLAGS, ...NEAR_COPY_FLAGS].map(flag => sql`${flag}`), sql`, `)}]::text[]`;
  const [posts, chat] = await Promise.all([
    db.select({ from: entries.lang, to: translations.lang, at: translations.createdAt, updatedAt: translations.updatedAt }).from(translations)
      .innerJoin(entries, eq(entries.id, translations.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .where(and(visibleWithTopic(), eq(translations.kind, "primary"), or(gte(translations.createdAt, starts[0]), gte(translations.updatedAt, starts[0])), lt(translations.createdAt, now),
        sql`not (${translations.flags} && ${excludedFlags})`)),
    db.select({ at: chatMessageTranslations.createdAt }).from(chatMessageTranslations)
      .innerJoin(chatMessages, eq(chatMessages.id, chatMessageTranslations.messageId))
      .innerJoin(villages, eq(villages.id, chatMessages.villageId))
      .where(and(isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt), chatVillageCondition(), isNotNull(villages.slug),
        eq(chatMessageTranslations.state, "ready"), gte(chatMessageTranslations.createdAt, starts[0]), lt(chatMessageTranslations.createdAt, now))),
  ]);
  const rows = [...posts, ...chat];
  const fourWeeksAgo = new Date(now.getTime() - 28 * 86400_000);
  return {
    weekly: starts.map(weekStart => ({ weekStart, count: rows.filter(row => weekStartOf(row.at).getTime() === weekStart.getTime()).length })),
    // Member-only chat activity never contributes source/target language pairs.
    pairs: new Set(posts.filter(row => row.at >= fourWeeksAgo || row.updatedAt >= fourWeeksAgo && row.updatedAt < now).map(row => `${row.from}:${row.to}`)).size,
    pairsFrom: fourWeeksAgo.toISOString(),
  };
}

// Linear work even for long drafts. Measure the span between the first and last
// changed character, an upper bound on edits, not a Levenshtein distance.
export function draftChangeSpan(before: string | null, after: string | null) {
  const a = before === null ? [] : [...before], b = after === null ? [] : [...after];
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  return { beforeChars: a.length, afterChars: b.length, changedChars: Math.max(a.length, b.length) - prefix - suffix, comparisonChars: Math.max(a.length, b.length), changed: before !== after };
}
export async function recordDraftPublication(db: Db, entryId: number, draft: { aiBaseline: { title: string | null; body: string } | null; aiSource: "api" | "mcp" | null; title: string | null; body: string }, now: Date) {
  if (!draft.aiBaseline || !draft.aiSource) return;
  const title = draftChangeSpan(draft.aiBaseline.title, draft.title);
  const body = draftChangeSpan(draft.aiBaseline.body, draft.body);
  await db.insert(aiDraftEdits).values({ entryId, source: draft.aiSource, beforeChars: title.beforeChars + body.beforeChars, afterChars: title.afterChars + body.afterChars, changedChars: title.changedChars + body.changedChars, comparisonChars: title.comparisonChars + body.comparisonChars, changed: title.changed || body.changed, publishedAt: now });
}

// A period selects report cohorts; correction status is read at collection time.
// Lifetime generation counters and draft edits have no weekly interpretation.
export async function translationQualitySignals(db: Db, period?: { from: Date; to: Date }) {
  const [state] = await db.select().from(qualityMetricState).where(eq(qualityMetricState.id, 1));
  if (!state) throw new Error("Quality metrics migration has not been applied");
  const since = period && period.from > state.startedAt ? period.from : state.startedAt;
  const [counts, postReports, chatReports, draftStats] = await Promise.all([
    period ? Promise.resolve([]) : db.select().from(translationSignalCounts),
    db.select({ from: translationReports.sourceLang, to: translationReports.lang, reports: sql<number>`count(*)::int`, corrected: sql<number>`count(${translationReports.correctedAt})::int`, days: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${translationReports.correctedAt} - ${translationReports.createdAt})) / 86400.0)` })
      .from(translationReports).where(and(gte(translationReports.createdAt, since), period ? lt(translationReports.createdAt, period.to) : undefined, sql`${translationReports.sourceLang} is not null`)).groupBy(translationReports.sourceLang, translationReports.lang),
    db.select({ from: chatTranslationReports.sourceLang, to: chatTranslationReports.lang, reports: sql<number>`count(*)::int`, corrected: sql<number>`count(${chatTranslationReports.correctedAt})::int`, days: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${chatTranslationReports.correctedAt} - ${chatTranslationReports.createdAt})) / 86400.0)` })
      .from(chatTranslationReports).where(and(gte(chatTranslationReports.createdAt, since), period ? lt(chatTranslationReports.createdAt, period.to) : undefined)).groupBy(chatTranslationReports.sourceLang, chatTranslationReports.lang),
    period ? Promise.resolve([]) : db.select({ source: aiDraftEdits.source, published: sql<number>`count(*)::int`, changed: sql<number>`count(*) filter (where ${aiDraftEdits.changed})::int`, beforeChars: sql<number>`coalesce(sum(${aiDraftEdits.beforeChars}), 0)::bigint`, afterChars: sql<number>`coalesce(sum(${aiDraftEdits.afterChars}), 0)::bigint`, changedChars: sql<number>`coalesce(sum(${aiDraftEdits.changedChars}), 0)::bigint`, comparisonChars: sql<number>`coalesce(sum(${aiDraftEdits.comparisonChars}), 0)::bigint` })
      .from(aiDraftEdits).innerJoin(entries, eq(entries.id, aiDraftEdits.entryId)).innerJoin(rootTopic, rootTopicOn()).where(and(visibleWithTopic(), isNull(entries.deletedAt))).groupBy(aiDraftEdits.source),
  ]);
  const byPair = new Map<string, { scope: "post" | "chat"; from: string; to: string; generated: number; reports: number; corrected: number; medianDays: number | null }>();
  for (const c of counts) byPair.set(`${c.scope}:${c.from}:${c.to}`, { ...c, reports: 0, corrected: 0, medianDays: null });
  for (const [scope, rows] of [["post", postReports], ["chat", chatReports]] as const) for (const row of rows) {
    const key = `${scope}:${row.from}:${row.to}`;
    const cell = byPair.get(key) ?? { scope, from: row.from!, to: row.to, generated: 0, reports: 0, corrected: 0, medianDays: null };
    Object.assign(cell, { reports: Number(row.reports), corrected: Number(row.corrected), medianDays: row.days === null ? null : Number(row.days) });
    byPair.set(key, cell);
  }
  return {
    since: since.toISOString(),
    translations: [...byPair.values()].sort((a, b) => `${a.scope}:${a.from}:${a.to}`.localeCompare(`${b.scope}:${b.from}:${b.to}`)).map(c => ({ ...c, reportRate: c.generated ? c.reports / c.generated : null, correctionRate: c.reports ? c.corrected / c.reports : null })),
    drafts: draftStats.map(d => ({ source: d.source, published: Number(d.published), changed: Number(d.changed), beforeChars: Number(d.beforeChars), afterChars: Number(d.afterChars), spanRate: Number(d.comparisonChars) ? Number(d.changedChars) / Number(d.comparisonChars) : null })),
  };
}
