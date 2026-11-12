import type { weeklyReadings } from "~/lib/reading-counts.server";
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
