import { Badge } from "~/components/ui/badge";
import { PendingText } from "~/components/pending-text";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import { CountWithLanguages } from "~/components/count-with-languages";
import { StancePanel } from "~/components/stance-panel";
import { TranslationLabel } from "~/components/translation-label";
import { AuthorLink } from "~/components/author-link";
import { LocalTime } from "~/components/local-time";
import { ListMeta } from "~/components/list-meta";
import { afterInitialActivation } from "~/lib/initial-activation";
import { remarkLine } from "~/lib/remark-line";
import type { PostsView } from "~/lib/list-seen";
import { UnreadDot } from "~/components/unread";
import type { TopicOrder } from "~/lib/entries.server";
import { pageSearch } from "~/lib/pagination";
import { peekHrefFor, stanceReturnTo, type StanceMessageParam } from "~/lib/stance-ui";
import type { TopicItem } from "~/lib/topic-list.server";
import { languageLabel } from "~/lib/language-label";
import { villageNameTitle } from "~/lib/village-translation-view";
import { m } from "~/paraglide/messages.js";

// One topic-list view. Titles use the display language (a translation when available), with a lang attribute; also show the original-language name and reply count.
// Each question retains one compact stance panel. Reply links use the latest visible reply's position.
// stanceMessage: the previous submission result without JavaScript (?stance_msg=), shown only on that question's panel.
// A post without a title (a remark) is drawn in the interface's voice (not the reading face of a title), plain and cut at two lines, so that a long remark does not take the place of an essay's title.
// trackNew (the first page in newest-first order without filters): remember the newest post shown, in the account for members or in the browser for guests (lib/list-seen.ts).
// After initial activation, mark newer rows with a dot and draw a line before previously seen rows.
export function TopicList({
  topics,
  langParam,
  empty,
  stanceMessage = null,
  reader = false,
  order = "activity",
  compactMeta = false,
  showOriginalLanguage = true,
  trackNew = false,
  actions,
}: {
  actions?: (topic: TopicItem) => ReactNode;
  reader?: boolean;
  topics: TopicItem[];
  langParam: string | null;
  empty: string;
  stanceMessage?: StanceMessageParam | null;
  order?: TopicOrder;
  compactMeta?: boolean;
  showOriginalLanguage?: boolean;
  trackNew?: boolean;
}) {
  const location = useLocation();
  const marks = useNewPostMarks(trackNew ? location.pathname : undefined, topics, location.key);
  if (topics.length === 0) return <p className="ui-help text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y">
      {topics.map((t) => (
        <Fragment key={t.id}>
        <li id={`q-${t.id}`} className="topic-row relative min-w-0 [overflow-wrap:anywhere]">
          {marks?.ids.has(t.id) && <UnreadDot label={m.list_new_post()} className="absolute start-[-0.875rem] top-[1.15rem]" />}
          <Link to={`/t/${t.id}${langParam ? `?lang=${langParam}` : ""}`} dir="auto" lang={t.title.lang} className="topic-title link-ui" data-remark={t.title.fromBody || undefined} data-translation-pending={t.title.pending || undefined}>
            {t.title.text ? (t.title.fromBody ? remarkLine(t.title.text) : t.title.text) : m.headline_empty()}
          </Link>
          {" "}<LocalTime iso={order === "activity" ? t.lastActivityAt : t.createdAt} className="topic-date ui-meta text-muted-foreground" />
          <ListMeta items={[
            { key: "author", content: <AuthorLink handle={t.authorHandle} name={t.authorName} reader={reader} /> },
            showOriginalLanguage && !(compactMeta && t.title.kind) && (!compactMeta || t.lang !== t.displayLang) && { key: "language", content: <span>{languageLabel(t.lang, t.langCode)}</span> },
            t.replyCount > 0 && { key: "replies", content: t.latestReply ? (
              <Link to={`/t/${t.id}${pageSearch(langParam ? `?lang=${langParam}` : "", t.latestReply.page)}#c-${t.latestReply.id}`} className="link-ui">
                {m.home_replies({ count: t.replyCount })}
              </Link>
            ) : <span>{m.home_replies({ count: t.replyCount })}</span> },
            t.newReplies && { key: "new-replies", content: <Link to={t.newReplies.href} className="link-ui inline-flex items-center gap-1"><UnreadDot />{m.following_new_replies({ count: t.newReplies.count })}</Link> },
            t.village && { key: "village", content: <Link to={`/v/${t.village.slug}`} title={villageNameTitle(t.village)} className="link-ui">{t.village.name}</Link> },
            t.asksStance && { key: "question", badge: true, content: <Badge variant="secondary" className="bg-info text-info-foreground">{m.question_badge()}</Badge> },
            t.hidden && { key: "hidden", badge: true, content: <Badge variant="secondary" title={m.entry_hidden_mark()} className="bg-notice text-notice-foreground">{m.entry_hidden_mark_short()}</Badge> },
            t.title.kind && { key: "translation", badge: !compactMeta, content: <TranslationLabel kind={t.title.kind} engine={t.title.engine} fallback={t.title.fallback} stale={t.title.stale} structureMismatch={t.title.structureMismatch} concise={compactMeta} fromLang={compactMeta && showOriginalLanguage ? languageLabel(t.lang, t.langCode) : undefined} plain={compactMeta && !showOriginalLanguage} /> },
            t.title.pending && { key: "pending", content: <span className="ui-meta"><PendingText short /></span> },
            t.title.unavailable && { key: "unavailable", content: <span role="status" className="ui-meta">{m.translation_unavailable()}</span> },
            t.insightful.total > 0 && { key: "insightful", content: <CountWithLanguages count={t.insightful} kind="insightful" /> },
          ]} />
          {actions && <div className="mt-1">{actions(t)}</div>}
          {t.asksStance && t.stance && (
            <div className="mt-2">
              <StancePanel
                questionId={t.id}
                stance={t.stance}
                distribution={t.distribution ?? null}
                peekHref={peekHrefFor(location.pathname, location.search, t.id, `q-${t.id}`)}
                compact
                message={stanceMessage?.questionId === t.id ? stanceMessage.message : null}
                returnTo={stanceReturnTo(location.pathname, location.search, `q-${t.id}`)}
                canChoose={t.canChoose ?? !t.hidden}
              />
            </div>
          )}
        </li>
        {marks?.boundaryAfter === t.id && <li data-seen-boundary="" className="flex items-center gap-3 py-2 ui-meta text-muted-foreground">
          <span aria-hidden="true" className="h-px flex-1 bg-rule" />
          <span>{m.list_seen_boundary()}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-rule" />
        </li>}
        </Fragment>
      ))}
    </ul>
  );
}

// The rows that are new since the reader last saw this list (see lib/list-seen.ts). Null until the page is live, and for a list that is not tracked.
// What counts as new is fixed for one visit (one navigation to the list), so that a reload of the data does not move the line; the next navigation starts again from what was seen.
function useNewPostMarks(scope: string | undefined, topics: readonly TopicItem[], navigationKey: string) {
  const member = useRouteLoaderData<typeof import("~/routes/member-layout").loader>("routes/member-layout");
  const memberId = member && "userId" in member ? member.userId : null;
  const [marks, setMarks] = useState<{ ids: Set<number>; boundaryAfter: number | null } | null>(null);
  const view = useRef<{ key: string; value: PostsView }>({ key: "", value: {} });
  const posts = useMemo(() => topics.map(t => ({ id: t.id, createdAt: t.createdAt })), [topics]);
  useEffect(() => {
    if (scope === undefined) { setMarks(null); return; }
    const key = `${scope}|${navigationKey}|${memberId ?? ""}`;
    if (view.current.key !== key) {
      view.current = { key, value: {} };
      setMarks(null);
    }
    const viewing = view.current.value;
    let cancelled = false;
    let cancel = () => {};
    void import("~/lib/list-seen").then(({ rememberViewingPosts, rememberMemberViewingPosts }) => {
      if (cancelled) return;
      cancel = afterInitialActivation(() => { void (async () => {
        if (cancelled) return;
        let found: ReturnType<typeof rememberViewingPosts>;
        try { found = memberId ? await rememberMemberViewingPosts(scope, posts, viewing) : rememberViewingPosts(window.localStorage, scope, posts, viewing); } catch { return; }
        if (cancelled) return;
        setMarks(found.newIds.length ? { ids: new Set(found.newIds), boundaryAfter: found.boundaryAfter } : null);
      })(); });
    });
    return () => { cancelled = true; cancel(); };
  }, [scope, navigationKey, posts, memberId]);
  return marks;
}
