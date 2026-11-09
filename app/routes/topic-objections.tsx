import { eq } from "drizzle-orm";
import { data, Link } from "react-router";
import type { Route } from "./+types/topic-objections";
import { AlternativeList, ObjectionList } from "~/components/objections-panel";
import { Pagination } from "~/components/pagination";
import { getReader } from "~/lib/auth/session.server";
import { entries } from "~/lib/db/schema";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { loadTitleDisplays } from "~/lib/entry-display.server";
import type { Lang } from "~/lib/languages";
import { listObjections } from "~/lib/objections.server";
import { parseId, parsePage } from "~/lib/params.server";
import { canSeeHidden, getViewer } from "~/lib/roles.server";
import { m } from "~/paraglide/messages.js";

import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";

// All objections to a question's framing: alternative questions and objection replies, newest first, 50 per page, without author grouping. Target of 「すべて見る」 from the question's panel showing the latest five, at most one per author.
// Non-question topics and deleted questions return 404. Hidden questions are visible only to their author, assigned moderators, and operators.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await getReader(request);
  const id = parseId(params.id);
  const page = parsePage(request);
  const [question] = await db
    .select({ id: entries.id, kind: entries.kind, asksStance: entries.asksStance, lang: entries.lang, authorId: entries.authorId, title: entries.title, sourceHash: entries.sourceHash, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(eq(entries.id, id));
  if (!question || question.kind !== "topic" || !question.asksStance || question.deletedAt) throw data("Not found", { status: 404 });
  if (question.hiddenAt && !canSeeHidden(user ? await getViewer(db, user) : undefined, question)) throw data("Not found", { status: 404 });
  const langs = { readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile) };
  const [result, titles] = await Promise.all([
    listObjections(db, id, { ...langs, page }),
    loadTitleDisplays(db, [{ id, lang: question.lang as Lang, title: question.title, sourceHash: question.sourceHash }], langs, true),
  ]);
  const title = titles.get(id)!;
  return { reader: !user, id, title: { text: title.text, lang: title.lang }, langParam: langCarry(request), page, ...result };
}

// Member-only viewer-specific screen; prevent shared caching.
export function headers() {
  return readingHeaders();
}

export function meta({ loaderData, matches }: Route.MetaArgs) {
  return [
    ...readingRobotsMeta(matches),
    { title: m.objections_page_title() },
    // Equivalent Markdown: thread Markdown, with alternative framings in question frontmatter and objections at the end of page one.
    ...(loaderData ? [{ tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/t/${loaderData.id}.md` }] : []),
  ];
}

export default function TopicObjections({ loaderData }: Route.ComponentProps) {
  const { id, title, alternatives, objections, hasNext, page, langParam } = loaderData;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.objections_page_title()}</h1>
      <p>
        <Link to={`/t/${id}${langParam ? `?lang=${langParam}` : ""}`} dir="auto" lang={title.lang} className="underline">
          {m.objections_back()}: {title.text}
        </Link>
      </p>
      <p className="ui-help text-muted-foreground">{alternatives.length || objections.length ? m.objections_neutrality() : m.objections_help()}</p>
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">{m.objections_alternatives()}</h2>
        <AlternativeList reader={loaderData.reader} items={alternatives} langParam={langParam} />
      </section>
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">{m.objections_replies()}</h2>
        <ObjectionList reader={loaderData.reader} items={objections} />
      </section>
      <Pagination page={page} hasNext={hasNext} />
      {!loaderData.reader && <p className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
        <Link to={`/t/${id}?write=objection#reply`} className="underline">
          {m.objections_write()}
        </Link>
        <Link to={`/t/new?asks_stance=1&alt_of=${id}`} className="underline">
          {m.objections_new_alt()}
        </Link>
      </p>}
    </main>
  );
}
