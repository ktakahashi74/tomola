import { createAvatarReport } from "~/lib/avatar-moderation.server";
import { createDisplayNameReport } from "~/lib/display-name-moderation.server";
import { lazy, Suspense, useState } from "react";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { setVillageFollow } from "~/lib/village-follows.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { Button } from "~/components/ui/button";
import { villageName } from "~/lib/village-name";
import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/member-page";
import { ListMeta } from "~/components/list-meta";
import { AuthorLink } from "~/components/author-link";
import { LocalTime } from "~/components/local-time";
import { Pagination } from "~/components/pagination";
import { TranslatedEntry } from "~/components/translated-entry";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { parseIdSet } from "~/lib/display";
import { displayLangFor, screenReadLangsFor } from "~/lib/display-lang.server";
import { LANG_LABELS } from "~/lib/languages";
import { loadMemberPageContent, resolveMemberPage } from "~/lib/member-pages.server";
import { parsePage } from "~/lib/params.server";
import { parsePageParam } from "~/lib/pagination";
import { m } from "~/paraglide/messages.js";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";

export const middleware: Route.MiddlewareFunction[] = [privateCacheMiddleware];

const DisplayNameReport = lazy(() => import("~/components/display-name-report"));

const privateHeaders = { "Cache-Control": "private, no-store" };

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, profile, db } = await requireMember(request);
  const member = await resolveMemberPage(db, params.handle ?? "");
  if (!member) throw data("Not found", { status: 404, headers: privateHeaders });
  if (member.redirectTo) throw redirect(member.redirectTo, { headers: privateHeaders });
  const query = new URL(request.url).searchParams;
  const personalPage = villagesEnabled() ? parsePageParam(query.get("vpage")) : 1;
  if (personalPage === null) throw data("Not found", { status: 404, headers: privateHeaders });
  const content = await loadMemberPageContent(db, member, {
    viewerId: user.id, readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile), page: parsePage(request), personalPage,
    forceOriginal: parseIdSet(query.getAll("orig")), forceTranslation: parseIdSet(query.getAll("tr")), forceOlder: parseIdSet(query.getAll("old")),
  });
  if ((content.page > 1 && content.topics.length === 0) || (content.personal && content.personal.page > 1 && content.personal.topics.length === 0)) throw data("Not found", { status: 404, headers: privateHeaders });
  return { ...content, reported: query.get("reported") === "1" };
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const member = await resolveMemberPage(db, params.handle ?? "");
  if (!member || member.redirectTo) throw data("Not found", { status: 404, headers: privateHeaders });
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "report-display-name" || intent === "report-avatar") {
    const rate = await hitMemberLimit(db, "report", user.id);
    if (!rate.allowed) return data({ error: "rate_limited" }, { status: 429, headers: { ...privateHeaders, ...rateLimitHeaders(rate) } });
    const result = await (intent === "report-avatar" ? createAvatarReport : createDisplayNameReport)(db, user.id, member.userId, { reason: form.get("reason"), note: form.get("note") });
    if (!result.ok) return data({ error: result.error }, { status: 400, headers: privateHeaders });
    return redirect(`/u/${member.handle}?reported=1`, { headers: privateHeaders });
  }
  if (!villagesEnabled()) throw data("Not found", { status: 404, headers: privateHeaders });
  if (intent !== "follow" && intent !== "unfollow") throw data("Invalid intent", { status: 400, headers: privateHeaders });
  const rate = await hitMemberLimit(db, "village-follow", user.id);
  if (!rate.allowed) return data({ error: "rate_limited" }, { status: 429, headers: { ...privateHeaders, ...rateLimitHeaders(rate) } });
  const result = await setVillageFollow(db, user.id, `@${member.handle}`, intent === "follow");
  if (!result.ok) throw data("Not found", { status: 404, headers: privateHeaders });
  return redirect(form.get("returnTo") === "/following" ? "/following" : `/u/${member.handle}#village`, { headers: privateHeaders });
}

export function headers() { return privateHeaders; }
export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.name ? `${loaderData.name} ` : ""}@${loaderData.handle} · ${m.site_name()}` : m.site_name() }];
}

export default function MemberPage({ loaderData, actionData }: Route.ComponentProps) {
  const { handle, own, intro, topics, page, hasNext, personal } = loaderData;
  const [reportOpen, setReportOpen] = useState(false);
  const [avatarReportOpen, setAvatarReportOpen] = useState(false);
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold wrap-anywhere">{loaderData.avatarUrl && <img src={loaderData.avatarUrl} alt="" className="member-avatar member-avatar-prominent me-3 inline-block rounded" />}<AuthorLink handle={handle} name={loaderData.name} latin={loaderData.nameLatin} byline reader/></h1>
      {actionData?.error && <p role="alert">{actionData.error === "duplicate" ? m.flag_already_reported() : m.flag_error()}</p>}
      {loaderData.reported && <p role="status">{m.flag_thanks()}</p>}
      {!own && loaderData.hasDisplayName && <details className="ui-meta" onToggle={event => { if (event.currentTarget.open) setReportOpen(true); }}>
        <summary className="cursor-pointer">{m.display_name_report()}</summary>
        {reportOpen && <Suspense fallback={null}><DisplayNameReport /></Suspense>}
      </details>}
      {!own && loaderData.hasUploadedAvatar && <details className="ui-meta" onToggle={event => { if (event.currentTarget.open) setAvatarReportOpen(true); }}>
        <summary className="cursor-pointer">{m.avatar_report()}</summary>
        {avatarReportOpen && <Suspense fallback={null}><DisplayNameReport avatar /></Suspense>}
      </details>}
      {intro ? (
        <section id={`p-${intro.id}`} className="space-y-3">
          <h2 className="text-lg font-semibold">{m.member_page_intro_heading()}</h2>
          <TranslatedEntry key={`${intro.id}:${intro.display.translation?.lang ?? "-"}:${intro.display.shown}`} {...intro} kind="topic" showHeading={false} meta={null} />
          <Link to={`/t/${intro.id}`} className="link-ui">{m.card_open()}</Link>
        </section>
      ) : own ? (
        <section className="space-y-2">
          <Link to="/t/new?intro=1" className="link-ui">{m.member_page_write_intro()}</Link>
          <p className="ui-help text-muted-foreground">{m.member_page_intro_hint()}</p>
        </section>
      ) : null}
      {personal && <section className="space-y-3" id="village" aria-labelledby="personal-village-heading">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="personal-village-heading" className="text-lg font-semibold">{m.member_page_topics_heading()}</h2>
          {!own && <Form method="post"><Button type="submit" variant="outline" size="sm" pressed={personal.following} name="intent" value={personal.following ? "unfollow" : "follow"}>{personal.following ? m.village_following() : m.village_follow()}<span className="sr-only"> @{handle}</span></Button></Form>}
        </div>
        {!own && <p className="ui-help text-muted-foreground">{m.member_page_village_follow_hint()}</p>}
        <MemberTopics topics={personal.topics} own={own} />
        <Pagination page={personal.page} hasNext={personal.hasNext} pageParam="vpage" anchor="#village" />
      </section>}
      <section className="space-y-3" id="posts">
        <h2 className={personal || intro || own ? "text-lg font-semibold" : "sr-only"}>{personal ? m.member_page_elsewhere() : m.member_page_topics_heading()}</h2>
        <MemberTopics topics={topics} own={own} />
        <Pagination page={page} hasNext={hasNext} anchor="#posts" />
      </section>
    </main>
  );
}

function MemberTopics({ topics, own }: { topics: Route.ComponentProps["loaderData"]["topics"]; own: boolean }) {
  return topics.length === 0 ? <p className="ui-help text-muted-foreground">{m.member_page_topics_empty()}</p> : <ul className="divide-y">{topics.map(topic => <li key={topic.id} className="topic-row">
    <Link to={`/t/${topic.id}`} dir="auto" lang={topic.title.lang} className="topic-title link-ui" data-translation-pending={topic.title.pending || undefined}>{topic.title.text || m.headline_empty()}</Link>
    {" "}<LocalTime iso={topic.createdAtISO} className="topic-date ui-meta text-muted-foreground" />
    <ListMeta items={[
      topic.village && !topic.village.language && { key: "village", content: <Link to={`/v/${topic.village.slug}`} className="link-ui">{villageName(topic.village)}</Link> },
      { key: "language", content: <span lang={topic.lang}>{LANG_LABELS[topic.lang]}</span> },
      own && (topic.readLanguageCount ?? 0) > 0 && { key: "read-languages", content: <span data-read-language-count={topic.readLanguageCount}>{m.member_page_read_languages({ count: topic.readLanguageCount! })}</span> },
    ]} />
  </li>)}</ul>;
}
