import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { data, Form, Link, redirect } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/home";
import { AsksFilter, type ListFilter } from "~/components/asks-filter";
import { OpenInAi } from "~/components/open-in-ai";
import { PageHeader } from "~/components/page-header";
import { HomeInstallGuide } from "~/components/home-install-guide";
import { PasskeyPrompt } from "~/components/passkey-prompt";
import { OrderSwitch } from "~/components/order-switch";
import { readingOnlyMark } from "~/lib/reading-lang";
import { ReadingList } from "~/components/reading-list";
import { clearReadingParams, readReadingRequest } from "~/lib/reading-page";
import { readingChunk } from "~/lib/reading-page.server";
import { TopicList } from "~/components/topic-list";
import { tracksNewPosts } from "~/lib/tracks-new-posts";
import { getReader, requireMember } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, readingLanguageChoice, screenReadLangsFor } from "~/lib/display-lang.server";
import { listTopics } from "~/lib/entries.server";
import { listAlternateQuery } from "~/lib/md/alternate";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { parseAsks, parseLong, parseOrder, parsePage } from "~/lib/params.server";
import { eq } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { FOLLOWING_HOME_LIST_SCOPE, isHomeScope, parseHomeScope, type HomeScope } from "~/lib/home-scope";
import { assertSameOrigin } from "~/lib/http/csrf.server";
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

function homeFilterHref(params: URLSearchParams) {
  const filters = new URLSearchParams();
  for (const key of ["order", "asks", "long", "lang"]) {
    const value = params.get(key);
    if (value !== null) filters.set(key, value);
  }
  const mark = readingOnlyMark(params.toString());
  if (mark && filters.has("lang")) filters.set("rl", mark);
  return filters.size ? `/?${filters}` : "/";
}

// A stance submission updates its own control without moving the list under the reader.
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) ? false : defaultShouldRevalidate;
}

export const middleware: Route.MiddlewareFunction[] = [readingChunk(loader, result => result)];

// The page shows member-specific content, so prevent shared caching. Read-delegation links are issued only by a separate user-triggered POST.
export function headers() {
  return readingHeaders();
}

export function meta({ loaderData, location, matches }: Route.MetaArgs) {
  return [
    ...readingRobotsMeta(matches),
    { title: "tomola" },
    // The preview of a link to the home page: the site's own introduction, in the language of the screen.
    ...sharePreviewMeta(matches, location, { type: "website", title: m.site_name(), description: m.home_intro_guest(), lang: getLocale() }),
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/home.md${listAlternateQuery(location.search, { followingHome: loaderData?.scope === "following" })}` },
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
  const followingAvailable = !!user && villagesEnabled();
  const explicitScope = followingAvailable ? parseHomeScope(url.searchParams) : null;
  if (explicitScope === "invalid") throw data("Bad request", { status: 400 });
  const scope = followingAvailable ? explicitScope ?? profile?.homeScope ?? "all" : "all";
  // A question always has a title, so the questions filter takes precedence over long posts.
  const filter: ListFilter = asksOnly ? "asks" : long ? "long" : "all";
  const result = await listTopics(db, user && scope === "following" ? { kind: "following-home", userId: user.id } : { kind: "all" }, { reading: readReadingRequest(request, order, page), page, viewer, order, asksOnly, titledOnly: filter === "long" });
  const filterReset = new URLSearchParams(url.search);
  clearReadingParams(filterReset);
  for (const key of ["page", "asks", "long", "_reading_chunk", "_routes"]) filterReset.delete(key);
  return {
    layout: "unified" as const,
    readingLanguage: readingLanguageChoice(request, profile),
    reader: !user,
    followingAvailable,
    scope,
    scopeAction: homeFilterHref(url.searchParams),
    filterReset: filterReset.size ? `/?${filterReset}` : "/",
    langParam: langCarry(request),
    order,
    filter,
    list: result.list!,
    page: result.page,
    hasNext: result.hasNext,
    topics: await toTopicItems(db, result.topics, { ...opts, showVillage: true }),
    stanceMessage,
    aiOpen: aiOpenLinks(request, profile, "/home", { asks: asksOnly, extra: { order, ...(filter === "long" ? { long: "1" } : {}), ...(scope === "following" ? { scope } : {}) } }),
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") throw data("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  const { user, db } = await requireMember(request);
  const form = await request.formData().catch(() => null);
  const scope = form?.get("scope");
  if (form?.get("intent") !== "home-scope" || !isHomeScope(scope)) throw data("Bad request", { status: 400 });
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const returnTo = homeFilterHref(new URL(request.url).searchParams);
  await db.update(profiles).set({ homeScope: scope }).where(eq(profiles.userId, user.id));
  return redirect(returnTo, 303);
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { topics, langParam, page, aiOpen, order, filter, stanceMessage, scope } = loaderData;
  const scopeOptions: [HomeScope, string][] = [["all", m.home_scope_all()], ["following", m.home_scope_following()]];
  return (
    <main className="space-y-4">
      {!loaderData.reader && <HomeInstallGuide />}
      <PageHeader
        title={m.home_unified_title()}
        hideTitle
        purpose={loaderData.reader ? m.home_intro_guest() : undefined}
        switches={<div className="w-full space-y-2">
          {loaderData.followingAvailable && <Form method="post" action={loaderData.scopeAction} className="flex flex-wrap gap-x-4 gap-y-1" aria-label={m.home_scope_label()}>
            <input type="hidden" name="intent" value="home-scope" />
            {scopeOptions.map(([value, label]) => <button key={value} type="submit" name="scope" value={value} aria-pressed={scope === value} className="choice ui-meta">{label}</button>)}
          </Form>}
          <div className="relative flex w-full flex-wrap items-center gap-x-3 gap-y-1">
            <OrderSwitch compact order={order} />
            <AsksFilter filter={filter} withLong collapsed />
            <div className="ms-auto"><OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} reader={loaderData.reader} /></div>
          </div>
        </div>}
      />
      {topics.length === 0 && filter !== "all"
        ? <p className="ui-help text-muted-foreground">{m.home_filter_empty()} <Link to={loaderData.filterReset} className="link-prose">{m.home_clear_filter()}</Link></p>
        : topics.length === 0 && scope === "following"
          ? <div className="space-y-2 ui-help text-muted-foreground">
              <p>{m.home_following_empty()}</p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                <li><Link to="/villages" className="link-prose">{m.nav_all_villages()}</Link></li>
                <li><Link to="/introductions" className="link-prose">{m.introductions_read()}</Link></li>
                <li><Link to="/?scope=all" className="link-prose">{m.home_see_all()}</Link></li>
              </ul>
            </div>
        : <ReadingList topics={topics} list={loaderData.list}>{items => <TopicList compactMeta seenScope={scope === "following" ? FOLLOWING_HOME_LIST_SCOPE : "/"} trackNew={!loaderData.list.older && tracksNewPosts({ page, order, filtered: filter !== "all" })} reader={loaderData.reader} topics={items} order={order} langParam={langParam} empty={m.home_empty()} stanceMessage={stanceMessage} />}</ReadingList>}
    </main>
  );
}

// Link the ordering rule to the principles page: members can read the rules and learn how to object.

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
