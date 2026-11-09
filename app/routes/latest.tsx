import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/latest";
import { AsksFilter } from "~/components/asks-filter";
import { OpenInAi } from "~/components/open-in-ai";
import { Pagination } from "~/components/pagination";
import { TopicList } from "~/components/topic-list";
import { getReader } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { listTopics } from "~/lib/entries.server";
import { listAlternateQuery } from "~/lib/md/alternate";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { parseAsks, parsePage } from "~/lib/params.server";
import { getViewer } from "~/lib/roles.server";
import { readPeekParam, readStanceMessage, skipRevalidationFor } from "~/lib/stance-ui";
import { toTopicItems } from "~/lib/topic-list.server";
import { m } from "~/paraglide/messages.js";

import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";

// Do not reload after /stance submissions; the stance panel updates from its own response.
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) ? false : defaultShouldRevalidate;
}

// The page shows member-specific content, so prevent shared caching. Read-delegation links are issued only by a separate user-triggered POST.
export function headers() {
  return readingHeaders();
}

export function meta({ location, matches }: Route.MetaArgs) {
  return [
    ...readingRobotsMeta(matches),
    { title: m.latest_title() },
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/latest.md${listAlternateQuery(location.search)}` },
  ];
}

// Recent posts: all topics ordered by latest activity, 30 per page.
export async function loader({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await getReader(request);
  const asksOnly = parseAsks(request);
  const result = await listTopics(db, { kind: "all" }, { page: parsePage(request), viewer: user ? await getViewer(db, user) : undefined, asksOnly });
  const url = new URL(request.url);
  const peekId = user ? readPeekParam(url) : null;
  return {
    reader: !user,
    langParam: langCarry(request),
    asksOnly,
    page: result.page,
    hasNext: result.hasNext,
    topics: await toTopicItems(db, result.topics, {
      readLangs: screenReadLangsFor(request, profile),
      displayLang: displayLangFor(request, profile),
      viewer: user && profile ? { userId: user.id, profile } : undefined,
      peek: new Set(peekId === null ? [] : [peekId]),
    }),
    stanceMessage: user ? readStanceMessage(url) : null,
    aiOpen: aiOpenLinks(request, profile, "/latest", { asks: asksOnly }),
  };
}

export default function Latest({ loaderData }: Route.ComponentProps) {
  const { topics, langParam, page, hasNext, aiOpen, asksOnly, stanceMessage } = loaderData;
  return (
    <main className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{m.latest_title()}</h1>
        <OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} reader={loaderData.reader} />
      </div>
      <AsksFilter asksOnly={asksOnly} />
      <TopicList reader={loaderData.reader} topics={topics} langParam={langParam} empty={m.home_empty()} stanceMessage={stanceMessage} />
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}
