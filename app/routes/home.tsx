import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { data, Link } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/home";
import { AsksFilter, type ListFilter } from "~/components/asks-filter";
import { OpenInAi } from "~/components/open-in-ai";
import { PageHeader } from "~/components/page-header";
import { HomeInstallGuide } from "~/components/home-install-guide";
import { PasskeyPrompt } from "~/components/passkey-prompt";
import { OrderSwitch } from "~/components/order-switch";
import { Pagination } from "~/components/pagination";
import { TopicList } from "~/components/topic-list";
import { tracksNewPosts } from "~/lib/tracks-new-posts";
import { getReader } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, readingLanguageChoice, screenReadLangsFor } from "~/lib/display-lang.server";
import { listTopics } from "~/lib/entries.server";
import { listAlternateQuery } from "~/lib/md/alternate";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { parseAsks, parseFollowing, parseLong, parseOrder, parsePage } from "~/lib/params.server";
import { hasVillagePlaces } from "~/lib/village-follows.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { getViewer } from "~/lib/roles.server";
import { readPeekParam, readStanceMessage, skipRevalidationFor } from "~/lib/stance-ui";
import { toTopicItems } from "~/lib/topic-list.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { feedAlternate, sharePreviewMeta } from "~/lib/share-meta";

import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";

export const handle = { PasskeyPrompt };

// A stance submission updates its own control without moving the list under the reader.
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
    { title: "tomola" },
    // The preview of a link to the home page: the site's own introduction, in the language of the screen.
    ...sharePreviewMeta(matches, location, { type: "website", title: m.site_name(), description: m.home_intro_guest(), lang: getLocale() }),
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/home.md${listAlternateQuery(location.search)}` },
    ...feedAlternate(matches, "/feed.xml", m.site_name(), location),
  ];
}

// Topics in every language, ordered by creation, latest activity or Insightful marks.
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await getReader(request);
  const page = parsePage(request);
  const asksOnly = parseAsks(request);
  // Show hidden topics only to their author, assigned moderators, and operators (viewer).
  const viewer = user ? await getViewer(db, user) : undefined;
  const displayLang = displayLangFor(request, profile);
  // Question stance panels: the viewer's own stance and distributions, only after choosing a stance or for ?peek=<id>. ?stance_msg= carries the previous submission result without JavaScript.
  const url = new URL(request.url);
  const peekId = user ? readPeekParam(url) : null;
  const opts = { readLangs: screenReadLangsFor(request, profile), displayLang, viewer: user && profile ? { userId: user.id, profile } : undefined, peek: new Set(peekId === null ? [] : [peekId]) };
  const stanceMessage = user ? readStanceMessage(url) : null;

  const order = parseOrder(request);
  const long = parseLong(request);
  // Both filters: questions only (a question always has a title, so it is a long post too).
  // "Following" (members only, and only where villages exist): the posts of the villages the member follows or has joined. Questions-only wins over it, as over long posts.
  const followingAvailable = !!user && villagesEnabled();
  const filter: ListFilter = asksOnly ? "asks" : followingAvailable && parseFollowing(request) ? "following" : long ? "long" : "all";
  const result = await listTopics(db, user && filter === "following" ? { kind: "my-villages", userId: user.id } : { kind: "all" }, { page, viewer, order, asksOnly, titledOnly: filter === "long" });
  return {
    layout: "unified" as const,
    readingLanguage: readingLanguageChoice(request, profile),
    reader: !user,
    followingAvailable,
    // Only asked for when the "Following" list is empty: whether there is any village to read from at all.
    noVillagePlaces: user && filter === "following" && result.topics.length === 0 ? !await hasVillagePlaces(db, user.id) : false,
    langParam: langCarry(request),
    order,
    filter,
    page: result.page,
    hasNext: result.hasNext,
    topics: await toTopicItems(db, result.topics, { ...opts, showVillage: true }),
    stanceMessage,
    aiOpen: aiOpenLinks(request, profile, "/home", { asks: asksOnly, extra: { order, ...(filter === "long" ? { long: "1" } : {}) } }),
  };
}

// The home does not accept writing; the header links to the dedicated editor.
export function action({}: Route.ActionArgs) {
  throw data("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { topics, langParam, page, hasNext, aiOpen, order, filter, stanceMessage } = loaderData;
  return (
    <main className="space-y-4">
      {!loaderData.reader && <HomeInstallGuide />}
      <PageHeader
        title={m.home_unified_title()}
        hideTitle
        purpose={loaderData.reader ? m.home_intro_guest() : undefined}
        // One row for everything that changes the list: the order and the filter at the start; the language read and "Open in AI" packed at the end (the first of them has the auto margin).
        // On a narrow screen the end part wraps as it fits, so no single item is left alone on a line of its own.
        switches={<div className="relative flex w-full flex-wrap items-center gap-x-3 gap-y-1">
          <OrderSwitch compact order={order} />
          <AsksFilter filter={filter} withLong withFollowing={loaderData.followingAvailable} collapsed />
          <div className={loaderData.reader ? "ms-auto" : undefined}><OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} reader={loaderData.reader} /></div>
        </div>}
      />
      {loaderData.noVillagePlaces
        ? <p>{m.home_following_empty()} <Link to="/villages" className="link-prose">{m.nav_all_villages()}</Link></p>
        : <TopicList compactMeta trackNew={tracksNewPosts({ page, order, filtered: filter !== "all" })} reader={loaderData.reader} topics={topics} order={order} langParam={langParam} empty={m.home_empty()} stanceMessage={stanceMessage} />}
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}

// Link the ordering rule to the principles page: members can read the rules and learn how to object.

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
