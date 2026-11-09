import { ChevronDown } from "lucide-react";
import { data } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/area";
import { AsksFilter, type ListFilter } from "~/components/asks-filter";
import { OriginalLanguageFilter } from "~/components/original-language-filter";
import { OpenInAi } from "~/components/open-in-ai";
import { PageHeader } from "~/components/page-header";
import { OrderSwitch } from "~/components/order-switch";
import { ReadingLangMenu } from "~/components/reading-lang-menu";
import { Pagination } from "~/components/pagination";
import { TopicList } from "~/components/topic-list";
import { tracksNewPosts } from "~/lib/tracks-new-posts";
import { getReader } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, readingLanguageChoice, screenReadLangsFor } from "~/lib/display-lang.server";
import { listTopics } from "~/lib/entries.server";
import { listAlternateQuery } from "~/lib/md/alternate";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { isLang, LANG_LABELS } from "~/lib/languages";
import { areaMdMiddleware } from "~/lib/md/twin.server";
import { parseAsks, parseLong, parseOrder, parsePage } from "~/lib/params.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { getViewer } from "~/lib/roles.server";
import { readPeekParam, readStanceMessage, skipRevalidationFor } from "~/lib/stance-ui";
import { m } from "~/paraglide/messages.js";

import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";

// Handle /a/:lang.md and /a/:lang.txt here, returning Markdown without running the UI loader (app/lib/md/twin.server.ts).
export const middleware: Route.MiddlewareFunction[] = [areaMdMiddleware];

// A stance submission updates its own control without changing the list order.
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) ? false : defaultShouldRevalidate;
}

// The page shows member-specific content, so prevent shared caching. Read-delegation links are issued only by a separate user-triggered POST.
export function headers() {
  return readingHeaders();
}

export function meta({ loaderData, location, matches }: Route.MetaArgs) {
  return [
    ...readingRobotsMeta(matches),
    { title: loaderData ? m.area_title({ lang: LANG_LABELS[loaderData.lang] }) : m.site_name() },
    ...(loaderData ? [{ tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/a/${loaderData.lang}.md${listAlternateQuery(location.search)}` }] : []),
  ];
}

// List topics whose original uses this language, with the same order and filters as the home.
// Unknown languages are 404. Writing starts at /t/new.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await getReader(request);
  const lang = params.lang;
  if (!isLang(lang)) throw data("Not found", { status: 404 });
  const asksOnly = parseAsks(request);
  const long = parseLong(request);
  const order = parseOrder(request);
  const filter: ListFilter = asksOnly ? "asks" : long ? "long" : "all";
  const result = await listTopics(
    db,
    { kind: "langs", langs: [lang] },
    { page: parsePage(request), viewer: user ? await getViewer(db, user) : undefined, order, asksOnly, titledOnly: filter === "long" },
  );
  const url = new URL(request.url);
  const peekId = user ? readPeekParam(url) : null;
  return {
    reader: !user,
    readingLanguage: readingLanguageChoice(request, profile),
    lang,
    order,
    filter,
    langParam: langCarry(request),
    page: result.page,
    hasNext: result.hasNext,
    topics: await toTopicItems(db, result.topics, {
      showVillage: true,
      readLangs: screenReadLangsFor(request, profile),
      displayLang: displayLangFor(request, profile),
      viewer: user && profile ? { userId: user.id, profile } : undefined,
      peek: new Set(peekId === null ? [] : [peekId]),
    }),
    stanceMessage: user ? readStanceMessage(url) : null,
    aiOpen: aiOpenLinks(request, profile, `/a/${lang}`, { asks: asksOnly, extra: { order, ...(filter === "long" ? { long: "1" } : {}) } }),
  };
}

export default function Area({ loaderData }: Route.ComponentProps) {
  const { lang, topics, langParam, page, hasNext, aiOpen, order, filter, stanceMessage } = loaderData;
  return (
    <main className="space-y-3">
      <PageHeader
        title={m.area_title({ lang: LANG_LABELS[lang] })}
        heading={<details key={lang} className="relative min-w-0">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden"><h1 className="heading-1 inline">{m.area_title({ lang: LANG_LABELS[lang] })}</h1><ChevronDown aria-hidden="true" className="ms-1 inline size-4 align-middle text-muted-foreground" /></summary>
          <div className="absolute start-0 z-20 mt-1 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 shadow-md"><OriginalLanguageFilter lang={lang} /></div>
        </details>}
        actions={<OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} reader={loaderData.reader} />}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <OrderSwitch order={order} />
        <AsksFilter filter={filter} withLong />
        {!loaderData.reader && <ReadingLangMenu choice={loaderData.readingLanguage} className="ms-auto" />}
      </div>
      <TopicList compactMeta showOriginalLanguage={false} trackNew={tracksNewPosts({ page, order, filtered: filter !== "all" })} reader={loaderData.reader} topics={topics} order={order} langParam={langParam} empty={m.home_empty()} stanceMessage={stanceMessage} />
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}
