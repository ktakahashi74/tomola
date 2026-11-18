import { useLayoutEffect, useRef } from "react";
import { data, redirect, useLocation } from "react-router";
import type { Route } from "./+types/saved";
import { PageHeader } from "~/components/page-header";
import { ReadingList } from "~/components/reading-list";
import { readReadingRequest } from "~/lib/reading-page";
import { readingChunk } from "~/lib/reading-page.server";
import { SaveButton } from "~/components/save-button";
import { TopicList } from "~/components/topic-list";
import { requireMember } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { parsePage } from "~/lib/params.server";
import { getViewer } from "~/lib/roles.server";
import { listSavedTopics } from "~/lib/saved-topics.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { m } from "~/paraglide/messages.js";

const HEADERS = { "Cache-Control": "private, no-store" };
export const middleware: Route.MiddlewareFunction[] = [readingChunk(loader, result => result.data)];

export function headers() { return HEADERS; }
export function meta() { return [{ title: m.saved_title() }]; }

export async function loader({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const page = parsePage(request);
  const result = await listSavedTopics(db, user.id, { reading: readReadingRequest(request, "saved", page), page, viewer: await getViewer(db, user) });
  // Revalidation after removing the last row always leaves a reachable page.
  if (page > 1 && result.topics.length === 0) {
    const params = new URL(request.url).searchParams;
    params.set("page", String(page - 1));
    throw redirect(`/saved?${params}`, { headers: HEADERS });
  }
  return data({ list: result.list!, page, hasNext: result.hasNext, langParam: langCarry(request), topics: await toTopicItems(db, result.topics, {
    readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile),
    viewer: { userId: user.id, profile },
  }) }, { headers: HEADERS });
}

export default function Saved({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const removal = useRef<{ row: HTMLElement; next: Element | null; previous: Element | null } | null>(null);
  useLayoutEffect(() => {
    const target = removal.current;
    removal.current = null;
    if (!target || target.row.isConnected || document.activeElement !== document.body) return;
    const control = [target.next, target.previous].find(row => row?.isConnected)?.querySelector<HTMLButtonElement>("[data-save-topic] button");
    (control ?? main.current)?.focus({ preventScroll: true });
  }, [loaderData]);
  return <main ref={main} tabIndex={-1} className="space-y-3" onSubmitCapture={event => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter !== document.activeElement) return;
    const row = submitter?.closest<HTMLElement>("[data-reading-list] li.topic-row");
    if (row) removal.current = { row, next: row.nextElementSibling, previous: row.previousElementSibling };
  }}>
    <PageHeader title={m.saved_title()} />
    <ReadingList topics={loaderData.topics} list={loaderData.list}>{items => <TopicList compactMeta topics={items} langParam={loaderData.langParam} empty={m.saved_empty()}
      actions={topic => <SaveButton topicId={topic.id} saved returnTo={`${location.pathname}${location.search}`} />} />}</ReadingList>
  </main>;
}
