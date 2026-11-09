import type { PublicStats } from "~/lib/public-stats.server";
import { m } from "~/paraglide/messages.js";

type Table = { caption: string; headers: string[]; rows: string[][] };
type TimeNote = { iso: string; label: (time: string) => string };
export type StatsSection = { id: string; title: string; notes: Array<string | TimeNote>; tables: Table[] };
const count = (value: number | null) => value === null ? m.stats_small() : String(value);
const rate = (value: number | null, denominator: number | null) => value === null
  ? denominator === 0 ? m.stats_unmeasured() : m.stats_small()
  : `${(value * 100).toFixed(1)}%`;
const categories: Record<string, () => string> = {
  rights: m.quality_category_rights, negation: m.quality_category_negation, hedging: m.quality_category_hedging,
  attribution: m.quality_category_attribution, stance: m.quality_category_stance, terminology: m.quality_category_terminology,
  culture: m.quality_category_culture, symbols: m.quality_category_symbols, "short-reply": m.quality_category_short_reply,
};
const evalConfig = (run: NonNullable<PublicStats["evaluation"]>, at: string) => m.stats_eval_config({ at,
  translator: `${run.translator.provider} / ${run.translator.model}`, judge: `${run.judge.provider} / ${run.judge.model}`, version: run.setVersion });

// Both representations use only the already suppressed public snapshot.
export function publicStatsSections(stats: PublicStats): StatsSection[] {
  const week = (value: string) => value === stats.currentWeek ? m.stats_partial({ week: value }) : value;
  const counts = (caption: string, rows: PublicStats["translations"], heading = m.stats_count()): Table => ({
    caption, headers: [m.metrics_col_week(), heading], rows: rows.map(row => [week(row.week), count(row.count)]),
  });
  const rateTable = (caption: string, rows: PublicStats["replies"], cohort = false): Table => ({
    caption, headers: [cohort ? m.stats_cohort() : m.metrics_col_week(), m.stats_numerator(), m.stats_denominator(), m.metrics_col_rate(), m.metrics_col_people()],
    rows: rows.map(row => [week(row.week), count(row.numerator), count(row.denominator), rate(row.rate, row.denominator), count(row.people ?? null)]),
  });
  const evaluation = stats.evaluation;
  const evalTable = (category: boolean): Table => ({
    caption: category ? m.quality_eval_category() : m.quality_eval_pair(),
    headers: [category ? m.quality_eval_category() : m.quality_eval_pair(), m.quality_eval_preserved(), m.metrics_col_rate(), m.quality_eval_severe()],
    rows: (evaluation ? category ? evaluation.categories : evaluation.pairs : []).map(row => [
      category ? categories[row.label]?.() ?? row.label : row.label,
      `${row.preserved} / ${row.total}`, rate(row.rate, row.total), String(row.severe),
    ]),
  });
  const retention = rateTable(m.stats_retention(), stats.retention, true);
  retention.rows = retention.rows.map((row, index) => stats.retention[index].observed ? row : [row[0], ...Array<string>(4).fill(m.stats_unmeasured())]);
  return [
    { id: "system", title: m.stats_system(), notes: [], tables: [] },
    { id: "evaluation", title: m.stats_evaluation(), notes: [m.stats_eval_help(), ...(evaluation ? [
      evaluation.finishedAt ? { iso: evaluation.finishedAt, label: (at: string) => evalConfig(evaluation, at) } : evalConfig(evaluation, "—"),
      ...(evaluation.sameProvider ? [m.stats_eval_same_provider()] : []),
      ...(evaluation.configurationChanged ? [m.stats_eval_changed()] : []),
    ] : [m.stats_unmeasured()])], tables: evaluation ? [evalTable(false), evalTable(true)] : [] },
    { id: "translations", title: m.stats_translations(), notes: [m.stats_translation_help()], tables: [counts(m.stats_translations(), stats.translations)] },
    { id: "pairs", title: m.stats_pairs(), notes: [{ iso: stats.languagePairs.from, label: from => m.stats_pairs_help({ from }) }, count(stats.languagePairs.count)], tables: [] },
    { id: "reports", title: m.stats_reports(), notes: [m.stats_report_help(), { iso: stats.reports[0]?.since ?? stats.generatedAt, label: since => m.stats_signals_since({ since }) }], tables: [{
      caption: m.stats_reports(), headers: [m.metrics_col_week(), m.stats_report_count(), m.stats_corrected(), m.stats_eligible(), m.stats_correction_rate()],
      rows: stats.reports.map(row => [week(row.week), count(row.count), count(row.correction.numerator), count(row.correction.denominator), rate(row.correction.rate, row.correction.denominator)]),
    }] },
    { id: "reactions", title: m.stats_reactions(), notes: [], tables: [] },
    { id: "replies", title: m.stats_replies(), notes: [m.stats_reply_help()], tables: [rateTable(m.stats_replies(), stats.replies)] },
    { id: "insightful", title: m.stats_insightful(), notes: [m.stats_insightful_help()], tables: [rateTable(m.stats_insightful(), stats.insightful)] },
    { id: "scale", title: m.stats_scale(), notes: [], tables: [] },
    { id: "active", title: m.stats_active(), notes: [m.stats_active_help()], tables: [counts(m.stats_active(), stats.active, m.metrics_col_people())] },
    { id: "retention", title: m.stats_retention(), notes: [m.stats_retention_help()], tables: [retention] },
  ];
}

const md = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
export function publicStatsMarkdown(stats: PublicStats): string {
  return [`# ${m.stats_title()}`, m.stats_intro(), m.stats_period(), m.stats_updated({ at: stats.generatedAt }), m.stats_privacy(),
    ...publicStatsSections(stats).flatMap(section => [
      `## ${section.title}`, ...section.notes.map(note => md(typeof note === "string" ? note : note.label(note.iso))),
      ...section.tables.map(table => [
        `| ${table.headers.map(md).join(" | ")} |`, `| ${table.headers.map(() => "---").join(" | ")} |`,
        ...table.rows.map(row => `| ${row.map(md).join(" | ")} |`),
      ].join("\n")),
    ]),
  ].join("\n\n") + "\n";
}
