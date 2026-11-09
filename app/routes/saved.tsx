import { data, redirect, useLocation } from "react-router";
import type { Route } from "./+types/saved";
import { PageHeader } from "~/components/page-header";
import { Pagination } from "~/components/pagination";
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
export function headers() { return HEADERS; }
export function meta() { return [{ title: m.saved_title() }]; }

export async function loader({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const page = parsePage(request);
  const result = await listSavedTopics(db, user.id, { page, viewer: await getViewer(db, user) });
  // Revalidation after removing the last row always leaves a reachable page.
  if (page > 1 && result.topics.length === 0) {
    const params = new URL(request.url).searchParams;
    params.set("page", String(page - 1));
    throw redirect(`/saved?${params}`, { headers: HEADERS });
  }
  return data({ page, hasNext: result.hasNext, langParam: langCarry(request), topics: await toTopicItems(db, result.topics, {
    readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile),
    viewer: { userId: user.id, profile },
  }) }, { headers: HEADERS });
}

export default function Saved({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  return <main className="space-y-3">
    <PageHeader title={m.saved_title()} />
    <TopicList compactMeta topics={loaderData.topics} langParam={loaderData.langParam} empty={m.saved_empty()}
      actions={topic => <SaveButton topicId={topic.id} saved returnTo={`${location.pathname}${location.search}`} />} />
    <Pagination page={loaderData.page} hasNext={loaderData.hasNext} />
  </main>;
}
