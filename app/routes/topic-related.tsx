import { publicTopicPlace } from "~/lib/visibility.server";
import { and, eq, isNull } from "drizzle-orm";
import { data, Link } from "react-router";
import type { Route } from "./+types/topic-related";
import { RelatedDiscussionList } from "~/components/related-discussions";
import { Pagination } from "~/components/pagination";
import { getReader } from "~/lib/auth/session.server";
import { entries } from "~/lib/db/schema";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { parseId, parsePage } from "~/lib/params.server";
import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { m } from "~/paraglide/messages.js";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user, profile } = await getReader(request);
  const id = parseId(params.id), page = parsePage(request);
  const [topic] = await db.select({ id: entries.id }).from(entries).where(and(eq(entries.id, id), eq(entries.kind, "topic"), isNull(entries.hiddenAt), isNull(entries.deletedAt), publicTopicPlace()));
  if (!topic) throw data("Not found", { status: 404 });
  const lang = langCarry(request);
  const result = await listRelatedDiscussions(db, id, { readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile), lang, page, typesetTitles: true });
  if (page > result.pageCount) throw data("Not found", { status: 404 });
  return { id, page, lang, reader: !user, rows: result.rows, hasNext: result.hasNext, pageCount: result.pageCount };
}

export function headers() { return readingHeaders(); }
export function meta({ matches }: Route.MetaArgs) { return [...readingRobotsMeta(matches), { title: m.related_title() }]; }

export default function TopicRelated({ loaderData }: Route.ComponentProps) {
  const { id, rows, page, hasNext, pageCount, lang } = loaderData;
  return <main className="space-y-4">
    <h1 className="text-2xl font-bold">{m.related_title()}</h1>
    <Link to={`/t/${id}${lang ? `?lang=${lang}` : ""}`} className="ui-meta underline">{m.related_back()}</Link>
    <RelatedDiscussionList rows={rows} />
    <Pagination page={page} hasNext={hasNext} lastPage={pageCount} />
  </main>;
}
