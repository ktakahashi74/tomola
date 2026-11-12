import type { PublicStats } from "./public-stats.server";
import type { StatsSection } from "./public-stats-view";
import { m } from "~/paraglide/messages.js";

export const readingSourceLabels = () => ({ share_link: m.stats_reading_share(), search: m.stats_reading_search(), social: m.stats_reading_social(),
  ai: m.stats_reading_ai(), other_site: m.stats_reading_other(), none: m.stats_reading_none(), internal: m.stats_reading_internal() });
export const readingMethodLabels = () => ({ markdown: m.stats_reading_markdown(), api: "API", mcp: "MCP", ai_crawler: m.stats_reading_crawler() });

export function readingStatsSection(reading: PublicStats["reading"], currentWeek: string): StatsSection {
  const small = (value: number | null) => value === null ? m.stats_small() : String(value);
  const percent = (value: number | null) => value === null ? m.stats_small() : `${(value * 100).toFixed(1)}%`;
  const sourceLabels = readingSourceLabels(), methodLabels = readingMethodLabels();
  const week = (value: string) => value === currentWeek ? m.stats_partial({ week: value }) : value;
  const cell = (observed: boolean, value: string) => observed ? value : m.stats_unmeasured();
  return { id: "reading", title: m.stats_reading_title(), notes: [m.stats_reading_help(),
    reading.since ? m.stats_reading_since({ since: reading.since }) : m.stats_unmeasured(),
    m.stats_reading_translation_help(), m.stats_reading_source_help(), m.stats_reading_tools_help()], tables: [
    { caption: m.stats_reading_title(), headers: [m.metrics_col_week(), m.stats_count(), m.stats_reading_translated()],
      rows: reading.weeks.map(row => [week(row.week), cell(row.observed, small(row.count)), cell(row.observed, row.translated.denominator === 0 ? m.stats_unmeasured() : percent(row.translated.rate))]) },
    { caption: m.stats_reading_sources(), headers: [m.metrics_col_week(), ...Object.values(sourceLabels)],
      rows: reading.weeks.map(row => [week(row.week), ...row.sources.map(source => cell(row.observed, source.denominator === 0 ? m.stats_unmeasured() : percent(source.rate)))]) },
    { caption: m.stats_reading_tools(), headers: [m.metrics_col_week(), ...Object.values(methodLabels)],
      rows: reading.weeks.map(row => [week(row.week), ...row.methods.map(method => cell(row.observed, small(method.count)))]) },
  ] };
}
