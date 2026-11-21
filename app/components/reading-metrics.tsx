import { Link } from "react-router";
import { LocalTime } from "~/components/local-time";
import type { topArticleReadings, weeklyReadings } from "~/lib/reading-counts.server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { m } from "~/paraglide/messages.js";

export function ReadingMetrics({ readings }: { readings: Awaited<ReturnType<typeof weeklyReadings>> }) {
  return <section className="space-y-2">
    <h2 className="text-lg font-semibold">{m.stats_reading_title()}</h2>
    <p>{m.metrics_reading_help()}</p>
    <p>{readings.since ? m.stats_reading_since({ since: readings.since }) : m.stats_unmeasured()}</p>
    <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow><TableHead>{m.metrics_col_week()}</TableHead><TableHead>{m.metrics_reading_source_lang()}</TableHead><TableHead>{m.metrics_reading_read_lang()}</TableHead><TableHead>{m.stats_count()}</TableHead></TableRow></TableHeader>
      <TableBody>{readings.weeks.flatMap(row => row.pairs.length ? row.pairs.map(pair => <TableRow key={`${row.week}:${pair.sourceLang}:${pair.readLang}`}>
        <TableCell>{row.week}</TableCell><TableCell>{pair.sourceLang}</TableCell><TableCell>{pair.readLang}</TableCell><TableCell>{pair.count}</TableCell>
      </TableRow>) : [<TableRow key={row.week}><TableCell>{row.week}</TableCell><TableCell>—</TableCell><TableCell>—</TableCell><TableCell>{row.observed ? "0" : m.stats_unmeasured()}</TableCell></TableRow>])}</TableBody>
    </Table></div>
  </section>;
}


export function ArticleReadingMetrics({ readings }: { readings: Awaited<ReturnType<typeof topArticleReadings>> }) {
  const { start, end, startedAt, articles } = readings;
  return <section aria-labelledby="article-reading-metrics" className="space-y-2">
    <h2 id="article-reading-metrics" className="text-lg font-semibold">{m.metrics_article_reading_title()}</h2>
    <p>{m.metrics_article_reading_period({ start, end })}</p>
    {startedAt && <p><LocalTime iso={startedAt.toISOString()} formatLabel={at => m.metrics_article_reading_since({ at })} /></p>}
    <p>{m.metrics_article_reading_help()}</p>
    {articles.length === 0 ? <p>{m.metrics_article_reading_empty()}</p> : <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow>
        {[m.metrics_article_reading_article(), m.stats_reading_browser(), m.metrics_article_reading_original(),
          m.metrics_article_reading_translated(), m.stats_reading_markdown(), "API", "MCP", m.stats_reading_crawler()]
          .map(label => <TableHead key={label} scope="col">{label}</TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{articles.map(row => <TableRow key={row.id}>
        <TableCell className="max-w-xs whitespace-normal break-words"><Link to={`/t/${row.id}`} className="underline">{row.title || m.headline_empty()}</Link></TableCell>
        {[row.browser, row.browser - row.translated, row.translated, row.markdown, row.api, row.mcp, row.crawler]
          .map((count, index) => <TableCell key={index} className="tabular-nums">{count}</TableCell>)}
      </TableRow>)}</TableBody>
    </Table></div>}
  </section>;
}
