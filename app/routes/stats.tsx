import { Link } from "react-router";
import { DocumentHeader } from "~/components/document-header";
import { LocalTime } from "~/components/local-time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { getReader } from "~/lib/auth/session.server";
import { readingRobotsMeta } from "~/lib/public-reading";
import { readingHeaders } from "~/lib/public-reading.server";
import { readPublicStats } from "~/lib/public-stats.server";
import { publicStatsSections } from "~/lib/public-stats-view";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import type { Route } from "./+types/stats";

export function headers() { return readingHeaders(); }
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: m.stats_title() }, ...readingRobotsMeta(matches),
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/stats.md?lang=${getLocale()}` }];
}
export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await getReader(request);
  return readPublicStats(db);
}

export default function Stats({ loaderData }: Route.ComponentProps) {
  return <>
    <DocumentHeader />
    <main className="mx-auto min-w-0 max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">{m.stats_title()}</h1>
      <p>{m.stats_intro()}</p>
      <p>{m.stats_period()}</p>
      <p className="ui-help text-muted-foreground"><LocalTime iso={loaderData.generatedAt} formatLabel={at => m.stats_updated({ at })} /></p>
      <p className="ui-help text-muted-foreground">{m.stats_privacy()}</p>
      <Link to={`/stats.md?lang=${getLocale()}`} reloadDocument className="underline">{m.stats_markdown()}</Link>
      {publicStatsSections(loaderData).map(section => <section key={section.id} aria-labelledby={`stats-${section.id}`} className="min-w-0 space-y-3">
        <h2 id={`stats-${section.id}`} className="text-lg font-semibold">{section.title}</h2>
        {section.notes.map((note, index) => <p key={index} className="break-words">{typeof note === "string" ? note : <LocalTime iso={note.iso} formatLabel={note.label} />}</p>)}
        {section.tables.map((table, index) => <div key={index} className="max-w-full overflow-x-auto">
          <Table>
            <caption className="sr-only">{table.caption}</caption>
            <TableHeader><TableRow>{table.headers.map((heading, i) => <TableHead key={i} scope="col">{heading}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{table.rows.map((row, i) => <TableRow key={i}>{row.map((cell, j) => <TableCell key={j}>{cell}</TableCell>)}</TableRow>)}</TableBody>
          </Table>
        </div>)}
      </section>)}
    </main>
  </>;
}
