import { Link } from "react-router";
import type { RelatedDiscussion } from "~/lib/related-discussions.server";
import { m } from "~/paraglide/messages.js";

export function RelatedDiscussionList({ rows }: { rows: RelatedDiscussion[] }) {
  return <ul className="space-y-3 text-sm [overflow-wrap:anywhere]">
    {rows.map(row => <li key={row.id} data-related-topic={row.id} className="space-y-1">
      <Link to={row.outgoing?.targetHref ?? row.incoming!.sourceHref} dir="auto" lang={row.title.lang} className="underline">{row.title.text}</Link>
      {(["outgoing", "incoming"] as const).map(kind => {
        const direction = row[kind];
        return direction && <p key={kind} className="flex flex-wrap gap-x-2 ui-meta text-muted-foreground">
          <span>{kind === "outgoing" ? m.related_outgoing() : m.related_incoming()}</span>
          <Link to={direction.sourceHref} className="underline">{m.related_source()}</Link>
        </p>;
      })}
    </li>)}
  </ul>;
}

export function RelatedDiscussions({ id, rows, omitted, lang }: { id: number; rows: RelatedDiscussion[]; omitted: boolean; lang: string | null }) {
  if (!rows.length) return null;
  return <section id="related" className="space-y-3 border-t pt-4">
    <h2 className="text-lg font-semibold">{m.related_title()}</h2>
    <RelatedDiscussionList rows={rows} />
    {omitted && <Link to={`/t/${id}/related${lang ? `?lang=${lang}` : ""}`} className="ui-meta underline">{m.related_all()}</Link>}
  </section>;
}
