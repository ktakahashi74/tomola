import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/following";
import { Link, useLocation } from "react-router";
import { AsksFilter } from "~/components/asks-filter";
import { PageHeader } from "~/components/page-header";
import { buttonVariants } from "~/components/ui/button";
import { MoreInfo } from "~/components/ui/more-info";
import { OpenInAi } from "~/components/open-in-ai";
import { Pagination } from "~/components/pagination";
import { TopicList } from "~/components/topic-list";
import { requireMember } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { listTopics } from "~/lib/entries.server";
import { listAlternateQuery } from "~/lib/md/alternate";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { parseAsks, parsePage } from "~/lib/params.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { getViewer } from "~/lib/roles.server";
import { readPeekParam, readStanceMessage, skipRevalidationFor } from "~/lib/stance-ui";
import { m } from "~/paraglide/messages.js";
import { loadFollowedNewReplies } from "~/lib/reply-locations.server";

// Followed topics in activity order. Stance submissions leave the list in place.
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) ? false : defaultShouldRevalidate;
}

// The page shows member-specific content, so prevent shared caching. Read-delegation links are issued only by a separate user-triggered POST.
export function headers() {
  return { "Cache-Control": "private" };
}

export function meta({ location }: Route.MetaArgs) {
  return [
    { title: m.following_title() },
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/following.md${listAlternateQuery(location.search, { streamFilters: false })}` },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const asksOnly = parseAsks(request);
  const url = new URL(request.url);
  const all = url.searchParams.get("all") === "1";
  const viewer = await getViewer(db, user);
  const result = await listTopics(db, { kind: "followed", userId: user.id, unreadOnly: !all }, { page: parsePage(request), order: "activity", viewer, asksOnly });
  // Distinguish a quiet follow list from a member who has no readable follows.
  const hasFollowedTopics = result.topics.length > 0 || (await listTopics(db, { kind: "followed", userId: user.id }, { limit: 1, viewer })).topics.length > 0;
  const peekId = readPeekParam(url);
  const newReplies = await loadFollowedNewReplies(db, user.id, result.topics.map(t => t.id));
  return {
    all,
    hasFollowedTopics,
    langParam: langCarry(request),
    asksOnly,
    page: result.page,
    hasNext: result.hasNext,
    topics: (await toTopicItems(db, result.topics, {
      readLangs: screenReadLangsFor(request, profile),
      displayLang: displayLangFor(request, profile),
      viewer: { userId: user.id, profile },
      peek: new Set(peekId === null ? [] : [peekId]),
    })).map(topic => ({ ...topic, newReplies: newReplies.get(topic.id) ?? null })),
    stanceMessage: readStanceMessage(url),
    aiOpen: aiOpenLinks(request, profile, "/following", { asks: asksOnly, extra: all ? { all: "1" } : undefined }),
  };
}

export default function Following({ loaderData }: Route.ComponentProps) {
  const { topics, langParam, page, hasNext, aiOpen, asksOnly, stanceMessage, all, hasFollowedTopics } = loaderData;
  const location = useLocation();
  const filterTo = (showAll: boolean) => {
    const params = new URLSearchParams(location.search);
    params.delete("page");
    params.delete("vpage");
    params.delete("all");
    if (showAll) params.set("all", "1");
    const search = params.toString();
    return `/following${search ? `?${search}` : ""}`;
  };
  return (
    <main className="space-y-3">
      {/* What the list is and how a post gets into it is one fold at the end of the filter row; an empty list says that itself. */}
      <PageHeader
        title={m.following_title()}
        actions={<OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} />}
        switches={<div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1">
          <nav aria-label={m.following_filter_label()} className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
            <Link to={filterTo(false)} aria-current={!all ? "true" : undefined} className="choice">{m.following_filter_new()}</Link>
            <Link to={filterTo(true)} aria-current={all ? "true" : undefined} className="choice">{m.following_filter_all()}</Link>
          </nav>
          <AsksFilter asksOnly={asksOnly} />
          {(hasFollowedTopics || asksOnly) && <MoreInfo label={m.following_auto_label()} className="ms-auto ui-meta text-muted-foreground open:basis-full">{m.following_rule()}</MoreInfo>}
        </div>}
      />
      {topics.length === 0 && !hasFollowedTopics ? (
        <div className="space-y-2">
          <p>{m.following_empty()}</p>
          <Link to="/" className={buttonVariants({ variant: "outline" })}>{m.following_empty_action()}</Link>
        </div>
      ) : topics.length === 0 && !all ? (
        <div className="space-y-2">
          <p>{m.following_no_new_replies()}</p>
          <Link to={filterTo(true)} className={buttonVariants({ variant: "outline" })}>{m.following_filter_all()}</Link>
        </div>
      ) : (
        <TopicList compactMeta
          topics={topics}
          langParam={langParam}
          empty={m.following_empty()}
          stanceMessage={stanceMessage}
        />
      )}
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}
