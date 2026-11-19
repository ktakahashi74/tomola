import { hasPostAiMaterial, hasPostAiMaterialInstructionWarning } from "~/lib/post-ai-materials.server";
import { renderNushiThread } from "~/lib/nushi-html.server";
import { readNushiAnswer, threadNushi, canRefreshNushi } from "~/lib/nushi.server";
import { nushiPreferences, nushiTopicDisabled } from "~/lib/nushi-settings.server";
import { nushiPlace } from "~/lib/nushi-materials.server";
import { nushiEnabled } from "~/lib/nushi-config.server";
import { getDb } from "~/lib/db/client.server";
import { nushiRequests } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadMemberAvatars } from "~/lib/member-avatar.server";
import { loadDisplayNames, selectDisplayName, selectDisplayNamePresentation } from "~/lib/display-names.server";
import { TitledMessage } from "~/components/titled-message";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { synchronizeTopicRead } from "~/lib/topic-read.server";
import { skipRevalidationFor } from "~/lib/stance-ui";
import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { data, Form, Link, useLocation } from "react-router";
import type { Route } from "./+types/topic";
import { entryErrorMessage } from "~/lib/entry-error-message";
import { SaveButton } from "~/components/save-button";
import { TopicActions } from "~/components/topic-actions";
import { ReadingActionMenu } from "~/components/reading-action-menu";
import { isTopicSaved } from "~/lib/saved-topics.server";
import { FollowButton } from "~/components/follow-button";
import { ObjectionsPanel } from "~/components/objections-panel";
import { Pagination } from "~/components/pagination";
import { ReasonsPanel, type ReasonView } from "~/components/reasons-panel";
import { StancePanel } from "~/components/stance-panel";
import { RepliesFilter, StanceTagChips, StanceTagLabel } from "~/components/stance-tag";
import { OpenInAi } from "~/components/open-in-ai";
import { ShareCardAddress } from "~/components/share-card-address";
import { EntryReactions } from "~/components/reactions";
import { TranslatedEntry, initialReportedTranslation } from "~/components/translated-entry";
import { DeleteEntryForm } from "~/components/delete-entry-form";
import { EntryReportForm } from "~/components/entry-report-form";
import { reasonLabel } from "~/components/reason-label";
import type { ReportReason } from "~/lib/moderation";
import { TranslationReportForm } from "~/components/translation-report-form";
import { getReader, getRequestViewer, getSessionUser, requireMember, requireWriter } from "~/lib/auth/session.server";
import { getWriter } from "~/lib/members.server";
import { distributionViewerFor, readDistributions } from "~/lib/distribution.server";
import { countReading } from "~/lib/reading-counts.server";
import { isAiCrawler } from "~/lib/reading-sources.server";
import { browserReadingLanguage } from "~/lib/reading-language.server";
import { displayLangFor, langCarry, readingLanguageChoice, screenReadLangsFor } from "~/lib/display-lang.server";
import { defaultPostLang } from "~/lib/profiles.server";
import { parseIdSet } from "~/lib/display";
import { loadEntryDisplays, type EntryDisplay } from "~/lib/entry-display.server";
import { headlineFromBody } from "~/lib/headline.server";
import { formString, readEntryForm } from "~/lib/entry-form.server";
import { getThread, replyLocationAt } from "~/lib/entries.server";
import { buildReplyBranches, splitReplyBranch } from "~/lib/reply-branches";
import { countReplyLanguages } from "~/lib/thread-overview.server";
import { loadReplyParents } from "~/lib/reply-branches.server";
import { ReplyBranchTail } from "~/components/reply-branch-tail";
import { loadLatestReplyLocations } from "~/lib/reply-locations.server";
import { getFollowState } from "~/lib/follows.server";
import { loadLatestEntryActions, loadOwnOpenReportIds } from "~/lib/moderation.server";
import { loadAltOrigin, loadObjectionPanel } from "~/lib/objections.server";
import { loadReasonExcerpts, loadReasonsPanel, type ReasonExcerpt } from "~/lib/reasons.server";
import { peekHrefFor, readPeekParam, readReviewParam, readStanceMessage, reviewHrefFor, stanceReturnTo, toDistributionView } from "~/lib/stance-ui";
import { isStanceTag, POSITIONS, type Position } from "~/lib/stances";
import { loadOwnStances, loadReviewTrigger } from "~/lib/stances.server";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { inScope } from "~/lib/roles.server";
import { loadOwnTranslationReports } from "~/lib/translation-reports.server";
import { availabilityKey, loadTranslationAvailability } from "~/lib/translation-availability.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { loadReactions, NO_REACTIONS } from "~/lib/votes.server";
import { isLang, type Lang, type SourceLang } from "~/lib/languages";
import { languageLabel } from "~/lib/language-label";
import { threadMdMiddleware } from "~/lib/md/twin.server";
import { readingReturnMiddleware } from "~/lib/auth/reading-return.server";
import { parseId, parseIdOrNull, parsePage } from "~/lib/params.server";
import { readEditedId, readPostedId } from "~/lib/posted-ui";
import { isFirstTopic, postedSourceLanguageStatus, postedTranslationStates } from "~/lib/posted-status.server";
import { useDropNoticeParams } from "~/components/posted-notice";
import { PostedTopicNotice } from "~/components/posted-topic-notice";
import { PostedLine } from "~/components/posted-line";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { topicVillage } from "~/lib/villages.server";
import { localizeVillage } from "~/lib/village-translations.server";
import { villageNameTitle } from "~/lib/village-translation-view";
import { postingVillageName, villageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";
import { SigningFailureResponse } from "~/lib/signing.server";
import { afterPageIdle } from "~/lib/initial-activation";
import { ListMeta } from "~/components/list-meta";
import { LocalTime } from "~/components/local-time";
import { ActionPanel } from "~/components/ui/action-panel";
import { AuthorLink } from "~/components/author-link";
import { deleteTopicEntry, flagTopicEntry, postTopicReply, reportTopicTranslation, saveReplyDraft, setTopicIntroduction, unsetTopicIntroduction } from "~/lib/topic-actions.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { loadReplyLocations } from "~/lib/reply-locations.server";
import { lazy, memo, startTransition, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { readingVersions } from "~/lib/reading.server";
import type { ReplyReadView } from "~/lib/seen-replies";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { RelatedDiscussions } from "~/components/related-discussions";
import { topicContinuation } from "~/lib/topic-continuation.server";
import { TopicContinuation } from "~/components/topic-continuation";

import { publicReading, readingHeaders } from "~/lib/public-reading.server";
import { topicShare } from "~/lib/share-preview.server";
import { sharePreviewMeta } from "~/lib/share-meta";
import { readerLoginHref, readingRobotsMeta } from "~/lib/public-reading";
import { consumeStanceResume, stanceResumeMiddleware } from "~/lib/stance-resume.server";
import { hasStanceConsent } from "~/lib/trial-consent.server";
import { collectSessionCookies } from "~/lib/auth/session-cookies.server";
import { postAskAiEnabled } from "~/lib/ai-question-config.server";

// Keep the native disclosure outside the lazy form's boundary. Hydration can
// replace a pending form, but must not remove the summary being pressed or
// reset its open state. The server still includes the complete form.
const TranslationWatch = lazy(() => import("~/components/translation-watch").then(module => ({ default: module.TranslationWatch })));
const NushiStatusWatches = lazy(() => import("~/components/nushi-status-watch"));
const LazyModerationPanel = lazy(() => import("~/components/moderation-panel").then(module => ({ default: module.ModerationForm })));
const ServerModerationPanel = import.meta.env.SSR ? (await import("~/components/moderation-panel")).ModerationForm : null;
const ModerationPanelContent: ComponentType<ComponentProps<typeof LazyModerationPanel>> = ServerModerationPanel ?? LazyModerationPanel;
const ModerationPanel = memo(function ModerationPanel({ className, ...props }: ComponentProps<typeof LazyModerationPanel> & { className?: string }) {
  return <ActionPanel label={m.mod_panel_summary()} className={className ?? "text-sm"} summaryClassName="touch-action h-auto px-1 ui-meta"><Suspense fallback={null}><ModerationPanelContent {...props} /></Suspense></ActionPanel>;
});
// Suspense keeps the server's form in place while the browser waits for idle
// time or interaction to hydrate it.
let startReplyFormLoad: () => void;
const replyFormReady = new Promise<void>(resolve => { startReplyFormLoad = () => resolve(); });
const LazyTopicReplyForm = lazy(() => replyFormReady
  .then(() => import("~/components/topic-reply-form"))
  // A failed import leaves the server's native form in place for submission.
  .catch(() => new Promise<never>(() => {})));
const ServerTopicReplyForm = import.meta.env.SSR ? (await import("~/components/topic-reply-form")).default : null;
const TopicReplyForm = ServerTopicReplyForm ?? LazyTopicReplyForm;

function LoadClientReplyForm() {
  // On client navigation the fallback mounts without a server form to show.
  useEffect(() => { startReplyFormLoad(); }, []);
  return null;
}

const topicCacheMiddleware: Route.MiddlewareFunction = async ({ request, params }, next) => {
  const response = await next();
  if (!(response instanceof Response)) return response;
  const member = await getSessionUser(request);
  const threadId = parseIdOrNull(params.id);
  const nushi = !member && nushiEnabled() && threadId !== null
    ? (await (await getDb()).select({ id: nushiRequests.id }).from(nushiRequests).where(eq(nushiRequests.threadId, threadId)).limit(1)).length > 0 : false;
  const headers = new Headers(response.headers);
  if (member || nushi) {
    // Saved state and changing AI replies must stay current in documents and client-router data requests.
    headers.set("Cache-Control", "private, no-store");
  } else {
    // The private response has no freshness lifetime, so a new request picks up the current hide preference.
    headers.append("Vary", "Cookie");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
// Handle /t/:id.md and /t/:id.txt here, returning Markdown without running the UI loader (app/lib/md/twin.server.ts).
export const middleware: Route.MiddlewareFunction[] = [threadMdMiddleware, readingReturnMiddleware, stanceResumeMiddleware, topicCacheMiddleware];

// These three controls show their own action responses. Other writes still reload
// the thread, including replies, reports, deletion and translation reports.

// Thread posts as visible to the viewer. Entries with withheld content (deleted replies and hidden posts this viewer may not see) return only their location and placeholder purpose
// without body, title, or author even in page data.
type Placeholder = { id: number; placeholder: "hidden" | "deleted" };

async function loaderImplementation({ request, params }: Route.LoaderArgs) {
  // When the reactions were read, as a lower bound: taken before any read, so a /vote response (whose `at` is taken after its own read) is never judged older than values this loader
  // read before it (components/reactions.tsx compares the two).
  const loadedAt = new Date().toISOString();
  const { user, db, profile } = await getReader(request);
  const url = new URL(request.url);
  // Show hidden post content only to the author, assigned moderators, and operators (viewer).
  const viewer = user ? await getRequestViewer(request) : undefined;
  // Replies paginate 100 per page (?page=); beyond the last page returns 404. Deleted replies retain their positions and count toward pagination.
  // ?tag=<tag> filters replies to that tag, excluding deleted and hidden entries. Paginate the filtered sequence. Unknown values do not filter.
  const tagParam = url.searchParams.get("tag");
  const stanceTag = isStanceTag(tagParam) ? tagParam : null;
  const thread = await getThread(db, parseId(params.id), { page: parsePage(request), viewer, stanceTag: stanceTag ?? undefined });
  if (!thread) throw data("Not found", { status: 404 });
  if (thread.page > thread.pageCount) throw data("Not found", { status: 404 });
  const { topic, replies } = thread;
  const resume = consumeStanceResume(request, user?.id, topic.id, !!profile && hasStanceConsent(profile));
  collectSessionCookies(resume.headers);
  const shown = [topic, ...replies].filter((e) => e.visibility === "visible" || e.visibility === "hidden");
  const displayLang = displayLangFor(request, profile);
  const readLangs = screenReadLangsFor(request, profile);
  const langs = { readLangs, displayLang };
  const carriedLang = langCarry(request);
  const topicVisible = topic.visibility === "visible";
  const topicReadable = topic.visibility !== "hidden-redacted";
  const asksStance = topicReadable && topic.asksStance;
  const questionVisible = topicVisible && asksStance;
  const showVillage = villagesEnabled() && topicReadable;
  const showContinuation = showVillage && topicVisible;
  // Return only fields needed by the UI, without raw body.
  // ?orig=<id>, ?tr=<id>, and ?old=<id> are link targets for switching versions without JavaScript.
  const displaysPromise = loadEntryDisplays(
    db,
    shown.map((e) => ({ id: e.id, kind: e.kind, lang: e.lang, sourceHash: e.sourceHash })),
    {
      browser: new Set(shown.filter(e => e.visibility === "visible").map(e => e.id)),
      readLangs,
      displayLang,
      forceOriginal: parseIdSet(url.searchParams.getAll("orig")),
      forceTranslation: parseIdSet(url.searchParams.getAll("tr")),
      forceOlder: parseIdSet(url.searchParams.getAll("old")),
    },
  );
  // The reason excerpts and the full thread share batched display-name and reaction lookups.
  const reasonData = (async () => {
    const reasonsLoaded = questionVisible ? await loadReasonsPanel(db, topic.id, { viewer, lang: carriedLang }) : null;
    const reasonViews = reasonsLoaded ? [...reasonsLoaded.views.values()].filter(v => v.visibility === "visible") : [];
    const forReactions = [...shown, ...reasonViews.filter(v => !shown.some(e => e.id === v.id))];
    const [authorNames, reasonExcerpts, reactions] = await Promise.all([
      loadDisplayNames(db, [...shown, ...reasonViews].map(e => e.authorHandle)),
      reasonViews.length ? loadReasonExcerpts(db, reasonViews, langs) : new Map<number, ReasonExcerpt>(),
      loadReactions(db, forReactions.map(e => ({ id: e.id })), user?.id ?? null),
    ]);
    return { reasonsLoaded, authorNames, reasonExcerpts, reactions };
  })();
  const [
    displays, { reasonsLoaded, authorNames, reasonExcerpts, reactions }, avatars, hiddenActions,
    ownOpenReportIds, ownTranslationReports, latestReply, ownStances, follow, replyParents,
    related, continuation, headline, objections, origin, translating,
  ] = await Promise.all([
    displaysPromise,
    reasonData,
    loadMemberAvatars(db, shown.map(e => e.authorHandle)),
    // Only affected authors receive action ids; privileged visibility alone does not grant an appeal.
    loadLatestEntryActions(db, shown.filter(e => e.visibility === "hidden" && e.authorId === user?.id).map(e => e.id), ["hide", "unhide"]),
    user ? loadOwnOpenReportIds(db, user.id, shown.map(e => e.id)) : new Set<number>(),
    user ? loadOwnTranslationReports(db, user.id, shown) : [],
    !stanceTag && thread.replyTotal > 10 ? loadLatestReplyLocations(db, [topic.id]).then(rows => rows.get(topic.id)) : undefined,
    user && asksStance ? loadOwnStances(db, user.id, [topic.id]) : null,
    user && topicReadable ? getFollowState(db, user.id, topic.id).then(state => ({ state })) : null,
    stanceTag ? [] : loadReplyParents(db, topic.id, replies.map(r => r.id)),
    listRelatedDiscussions(db, topic.id, { ...langs, inline: true, lang: carriedLang, typesetTitles: true }),
    showContinuation ? topicContinuation(db, topic.id, langs) : null,
    topicReadable && topic.title === null ? headlineFromBody(topic.body) : null,
    questionVisible ? loadObjectionPanel(db, topic.id, langs) : null,
    topicReadable && topic.altOf !== null ? loadAltOrigin(db, topic.altOf, langs) : null,
    // Mute only unfinished body work; unrequested languages still start work on read.
    user && topic.authorId === user.id && topicVisible
      ? loadTranslationAvailability(db, [topic], enabledLangs())
        .then(states => enabledLangs().filter(lang => lang !== topic.lang && states.get(availabilityKey(topic.id, lang)) === "pending"))
      : [],
    // Acknowledge the followed-thread notification on the same request as the layout.
    synchronizeTopicRead(request),
  ]);
  const displayOf = (id: number): EntryDisplay => displays.get(id) ?? { shown: "original", pending: false, translation: null };
  // "Insightful": only the total, language count and the viewer's own press.
  const reactionsOf = (id: number) => reactions.get(id) ?? NO_REACTIONS;
  const placeholderOf = (e: (typeof thread.replies)[number]): Placeholder => ({ id: e.id, placeholder: e.visibility === "deleted" ? "deleted" : "hidden" });
  const writeParam = user ? url.searchParams.get("write") : null;
  const parentIds = replies.filter(r => r.visibility !== "deleted" && r.visibility !== "hidden-redacted")
    .flatMap(r => r.parentId === null ? [] : [r.parentId]);
  const grouped = stanceTag ? null : buildReplyBranches(topic.id, replies, replyParents);
  const replyOnPage = new Map(replies.map(r => [r.id, r]));
  const missingRootIds = grouped?.filter(branch => !replyOnPage.has(branch.rootId)).map(branch => branch.rootId) ?? [];
  const targetParam = user ? url.searchParams.get("reply_to") : null;
  const targetId = targetParam && /^c-[1-9]\d*$/.test(targetParam) ? Number(targetParam.slice(2)) : null;
  // Right after posting a topic, its author is told in which language it was published and into which it is being translated (and welcomed, once, for the first).
  const ownPostedTopic = !!user && topic.visibility === "visible" && topic.authorId === user.id && readPostedId(url) === topic.id;
  const ownPostedEntry = !!user ? shown.find(entry => entry.visibility === "visible" && entry.authorId === user.id && readPostedId(url) === entry.id) : null;
  const postedNoticePromise = ownPostedEntry && user ? Promise.all([
    ownPostedTopic && isFirstTopic(db, user.id),
    postedTranslationStates(db, ownPostedEntry),
    postedSourceLanguageStatus(db, ownPostedEntry),
    ownPostedTopic && hasPostAiMaterialInstructionWarning(db, topic.id),
  ]).then(([first, langs, sourceStatus, warning]) => ({
    first, langs, sourceStatus,
    materialWarning: warning ? { text: m.ai_material_instruction_warning(), label: m.ai_material_link(), href: `/t/${topic.id}/ai-materials` } : null,
  })) : null;
  const alternateLang = url.searchParams.get("lang");
  const countCrawler = request.method === "GET" && url.pathname === `/t/${topic.id}` && thread.page === 1 && topicVisible &&
    !/prefetch/i.test(`${request.headers.get("purpose")} ${request.headers.get("sec-purpose")}`) &&
    isAiCrawler(request.headers.get("user-agent") ?? "");
  const nushiReplyId = Number(url.searchParams.get("nushi_reply"));
  const canTarget = targetId !== null && Number.isSafeInteger(targetId) && topicVisible;
  const nushiOn = nushiEnabled();
  // Question stance panel: viewer's own stance and version. Include distribution totals and language count only after stance selection or with ?peek=1; readDistributions excludes hidden questions.
  // Never include other members' stances. ?stance_msg= carries the previous submission result without JavaScript.
  const stancePromise = (async () => {
    if (!user || !profile || !asksStance) return null;
    const own = ownStances?.get(topic.id) ?? { position: null, version: 0 };
    const peeked = readPeekParam(url) !== null;
    const sent = readStanceMessage(url);
    const reviewParam = readReviewParam(url);
    const [distributions, triggerEntryId] = await Promise.all([
      own.position !== null || peeked ? readDistributions(db, [topic.id], distributionViewerFor({ userId: user.id, profile })) : null,
      // Ignore a trigger unless it can still be used for this reader's stance.
      own.position !== null && topicVisible && reviewParam !== null ? loadReviewTrigger(db, user.id, topic.id, reviewParam) : null,
    ]);
    const shownDistribution = distributions?.get(topic.id);
    return {
      stance: own,
      distribution: shownDistribution ? toDistributionView(shownDistribution) : null,
      peeked,
      message: sent && sent.questionId === topic.id ? sent.message : null,
      canChoose: topicVisible,
      triggerEntryId,
    };
  })();
  const nushiPromise = (async () => {
    const nushi = topicVisible ? await threadNushi(db, topic.id, [topic.id, ...replies.map(reply => reply.id)], displayLang) : { answers: [], requests: [] };
    const refreshable = await Promise.all(nushi.answers.map(async answer => await canRefreshNushi(db, answer, user?.id) ? answer.id : null));
    return { nushi, refreshable: refreshable.filter((id): id is number => id !== null) };
  })();
  const writerPromise = (async () => {
    const canWriteReply = !!user && !!profile && topicVisible && (await getWriter(db, user.id, { profile })).ok;
    return { canWriteReply, nushiAvailable: canWriteReply && !!await nushiPlace(db, topic.id) };
  })();
  const [
    stancePart, parents, target, postedNotice, village, share, { nushi, refreshable }, nushiPreference, nushiTopic,
    { canWriteReply, nushiAvailable }, nushiReply, material, saved, replyLangCount,
  ] = await Promise.all([
    stancePromise,
    loadReplyLocations(db, [topic.id], [...new Set([...parentIds, ...missingRootIds])], { viewer, lang: carriedLang }),
    canTarget ? loadReplyLocations(db, [topic.id], [targetId], { lang: carriedLang }).then(rows => rows.get(targetId)) : undefined,
    postedNoticePromise,
    !showVillage ? null : showContinuation ? continuation?.village ?? null
      : topicVillage(db, topic.id).then(value => value ? localizeVillage(db, value, langs) : null),
    // Member pages do not fetch public preview data.
    !user && publicReading() && topicVisible ? topicShare(db, topic, url.search) : null,
    nushiPromise,
    nushiOn ? nushiPreferences(db, user?.id, request) : { hide: false, citations: true },
    nushiOn && user?.id === topic.authorId ? nushiTopicDisabled(db, topic.id) : null,
    writerPromise,
    nushiReplyId > 0 && Number.isSafeInteger(nushiReplyId) ? readNushiAnswer(db, nushiReplyId) : null,
    topicVisible ? hasPostAiMaterial(db, topic.id) : null,
    user && topicReadable ? isTopicSaved(db, user.id, topic.id) : null,
    thread.replyCount >= 2 && topicVisible ? countReplyLanguages(db, topic.id) : 0,
    countCrawler ? countReading(db, topic.id, { method: "ai_crawler", readerId: user?.id, lang: () => browserReadingLanguage(db, { ...topic, kind: "topic", lang: topic.lang as Lang }, request, profile) }) : undefined,
  ]);
  const nushiView = { ...nushi, ...nushiPreference, setting: nushiTopic };
  const hiddenActionOf = (id: number) => {
    const current = hiddenActions.get(id);
    return current?.action === "hide" ? { id: current.id, reason: current.reason } : null;
  };
  // "Reconsider my stance": a small link next to the pressed button of a post in a question's thread, only for a viewer who holds a stance now (and the question takes stances).
  // It is not offered otherwise: offering it to someone without a stance would urge them to choose one.
  const canReview = stancePart !== null && stancePart.stance.position !== null && stancePart.canChoose;
  // Production revalidation keeps the single-fetch .data suffix in request.url. Links must target the document route, independent of that transport URL.
  const reviewHrefOf = (e: { id: number; visibility: string }): string | null => (canReview && e.visibility === "visible" ? reviewHrefFor(`/t/${topic.id}`, url.search, e.id) : null);
  // The reasons panel, as the page draws it: the three positions in a fixed order (agree, disagree, neither), whatever the viewer's own stance is.
  const reasons: Record<Position, ReasonView[]> | null = reasonsLoaded
    ? (Object.fromEntries(
        POSITIONS.map((position) => [
          position,
          reasonsLoaded.pick[position].flatMap((id): ReasonView[] => {
            const v = reasonsLoaded.views.get(id);
            if (!v || v.visibility !== "visible") return [];
            return [
              {
                id: v.id,
                lang: v.lang,
                authorHandle: v.authorHandle,
                authorName: selectDisplayName(authorNames.get(v.authorHandle)),
                excerpt: reasonExcerpts.get(v.id)!,
                reactions: reactionsOf(v.id),
                own: !!user && v.authorId === user.id,
                location: reasonsLoaded.locations.get(v.id) ?? `/t/${topic.id}#c-${v.id}`,
                reviewHref: reviewHrefOf(v),
              },
            ];
          }),
        ]),
      ) as Record<Position, ReasonView[]>)
    : null;
  const parentById = new Map(replyParents.map(r => [r.id, r.parentId]));
  const replyBranches = grouped?.map(branch => {
    const { folded } = splitReplyBranch(branch.replyIds);
    const postedId = readPostedId(url);
    const openFor = folded.find(id => id === targetId || id === postedId) ?? null;
    const head = replyOnPage.get(branch.replyIds[0])!;
    return {
      ...branch,
      root: branch.replyIds[0] === branch.rootId ? null : parents.get(branch.rootId) ?? { state: "unavailable" as const },
      suppressParentIds: branch.replyIds[0] === branch.rootId
        ? branch.replyIds.filter(id => parentById.get(id) === branch.rootId)
        : head.visibility !== "deleted" && head.visibility !== "hidden-redacted" && parentById.get(head.id) === branch.rootId ? [head.id] : [],
      openFor,
      open: openFor !== null,
    };
  }) ?? null;
  // Shared fields. hidden: content is shown to this viewer despite hidden status, with a 「非表示」 marker. canModerate: another author's post within the viewer's assigned scope, showing moderation controls.
  const common = (e: typeof topic) => {
    const name = selectDisplayNamePresentation(authorNames.get(e.authorHandle));
    return {
      id: e.id,
      placeholder: null,
      lang: e.lang,
      langCode: e.langCode,
      avatarUrl: avatars.get(e.authorHandle),
      authorHandle: e.authorHandle,
      authorName: name.name,
      authorNameLatin: name.latin,
      html: e.html,
      createdAt: e.createdAt,
      editedAt: e.editedAt,
      // Reply tag: named stance and reason, or objection, supplied by the author.
      stanceTag: e.stanceTag,
      canEdit: !!user && e.authorId === user.id && (e.id !== topic.id || !topic.stanceLocked),
      own: !!user && e.authorId === user.id,
      posted: !!user && e.authorId === user.id && readPostedId(url) === e.id,
      hidden: e.visibility === "hidden",
      hiddenAction: hiddenActionOf(e.id),
      reported: ownOpenReportIds.has(e.id),
      translationReports: ownTranslationReports.filter(report => report.entryId === e.id),
      canModerate: !!user && !!viewer && e.authorId !== user.id && inScope(viewer.scope, e.lang),
      display: displayOf(e.id),
      reactions: reactionsOf(e.id),
      reviewHref: reviewHrefOf(e),
    };
  };
  return {
    aiMaterialLinks: [
      ...(material ? [{ href: `/t/${topic.id}/ai-materials`, label: m.ai_material_link() }] : []),
      ...(user?.id === topic.authorId ? [{ href: `/t/${topic.id}/ai-materials/edit`, label: material ? m.ai_material_title() : m.ai_material_add() }] : []),
    ],
    nushi: renderNushiThread(nushiView, [{ id: topic.id }, ...replies.map(reply => ({ id: reply.id, nushiParentId: reply.nushiParentId }))], { threadId: topic.id, member: !!user, back: `/t/${topic.id}${url.search}`, refreshable, reply: nushiReply && !nushiReply.hidden && nushiReply.threadId === topic.id ? nushiReply.id : undefined }),
    nushiAvailable,
    reader: !user,
    askAi: user && topic.visibility === "visible" && postAskAiEnabled()
      ? { href: `/t/${topic.id}/ask?${new URLSearchParams({ lang: displayLang })}`, label: m.post_ask_entry() } : null,
    canReply: !!user && topic.visibility === "visible",
    respondWithPost: canWriteReply
      ? { formAction: `/t/new?respond=${topic.id}`, children: m.respond_with_post(), variant: "outline" as const, intent: "respond", formNoValidate: true } : null,
    stanceResume: resume.position,
    share,
    ...(showVillage ? { village } : {}),
    ...(showContinuation ? { continuation } : {}),
    introSelected: !!user && profile?.introEntryId === topic.id,
    postedNotice,
    edited: user ? readEditedId(url) : null,
    topic:
      topic.visibility === "hidden-redacted"
        ? placeholderOf(topic)
        : {
            ...common(topic),
            // null: a topic without a title. The heading and the browser title then come from the beginning of the body (headline, and the one of each translation).
            title: topic.title,
            headline: headline,
            reading: readingVersions(topic.html, topic.lang, displayOf(topic.id)),
            longTranslation: topic.body.length >= 8_000,
          },
    // Question attributes: asksStance, alternative-framing source question (altOf with null origin shows 「元の問いは読めません」), and lock state (locked for authors, canFix for typo correctors; omit timestamp).
    question: {
      asksStance,
      isAlt: topic.visibility !== "hidden-redacted" && topic.altOf !== null,
      origin,
      locked: !!user && topic.visibility !== "hidden-redacted" && topic.stanceLocked && topic.authorId === user.id,
      // Users permitted to correct locked-question typos: source-language moderators and operators, excluding the author. Show the 「誤字を直す」 entry point.
      canFix: !!user && topic.visibility !== "hidden-redacted" && topic.stanceLocked && topic.authorId !== user.id,
      stance: stancePart,
      reasons,
      objections,
    },
    loadedAt,
    stanceTag,
    follow,
    saved,
    postedFollowed: follow?.state === "following" && url.searchParams.get("followed") === "1",
    replyTarget: canTarget
      ? { id: targetId, href: target?.state === "visible" ? target.href : null, handle: target?.state === "visible" ? target.authorHandle : null } : null,
    replyToTopic: !!user && targetParam === "",
    // Reply-form default tag (?write=<tag>), linked from 「異議を返信で書く」.
    writeTag: asksStance && isStanceTag(writeParam) ? writeParam : null,
    langParam: carriedLang,
    markdownHref: `/t/${topic.id}.md${isLang(alternateLang) ? `?lang=${alternateLang}` : ""}`,
    replyCount: thread.replyCount,
    // In how many original languages the readable replies are written; shown in the replies heading from two on. Fewer than two replies cannot differ.
    replyLangCount,
    replyBranches,
    replies: replies.map((r) => (r.visibility === "deleted" || r.visibility === "hidden-redacted" ? placeholderOf(r) : {
      ...common(r), nushiParentId: r.nushiParentId ?? null, parent: r.parentId === null ? null : parents.get(r.parentId) ?? { state: "unavailable" as const },
    })),
    page: thread.page,
    hasNextPage: thread.page < thread.pageCount,
    pageCount: thread.pageCount,
    latestReplyHref: latestReply ? replyLocationAt(topic.id, latestReply.id, latestReply.page, { lang: carriedLang }) : null,
    // Show deletion in moderation controls only to operators.
    operator: viewer?.scope.operator ?? false,
    ownerId: user?.id ?? null,
    connectDraftLabel: m.connect_draft_link(),
    defaultLang: profile ? defaultPostLang(profile) : displayLang,
    signPosts: profile?.signPosts ?? false,
    displayLang,
    readingLanguage: readingLanguageChoice(request, profile),
    translating,
    related,
    // Token-free Markdown URL. Members request a delegated key on click; public readers open this URL directly.
    // UI and Markdown pagination both count deleted replies, so use the same page number.
    // Tag-filtered reply pages do not align with unfiltered Markdown pagination; link to page one.
    aiOpen: aiOpenLinks(request, profile, `/t/${topic.id}`, { page: stanceTag ? 1 : thread.page }),
  };
}

// Read-delegation links are issued only by a separate user-triggered POST.
export function headers() {
  return readingHeaders();
}

export function meta({ loaderData, location, matches }: Route.MetaArgs) {
  const topic = loaderData?.topic;
  const full = topic && topic.placeholder === null ? topic : null;
  const translated = full?.display.shown === "translation" ? full.display.translation : null;
  // A topic with a title: the title (its translation when the translation is shown). A topic without a title: the beginning of the body, in the shown version.
  const line = full ? (full.title !== null ? (translated?.title?.text ?? full.title) : (translated?.headline ?? full.headline)) : null;
  const title = line ? full?.title === null && Array.from(line).length > 40 ? `${Array.from(line).slice(0, 40).join("")}…` : line : m.site_name();
  const share = loaderData?.share;
  return [
    ...readingRobotsMeta(matches),
    { title },
    // The preview of a link to this page. Only a topic everyone may read has one (`share`); a hidden, deleted or closed one gets none.
    ...sharePreviewMeta(matches, location, full && share && share.title ? { type: "article", title: share.title, description: share.description, lang: share.lang, image: share.image, publishedTime: new Date(full.createdAt).toISOString(), author: share.author } : null),
    // Equivalent Markdown without a token. Preserve ?lang=.
    ...(topic ? [{ tagName: "link" as const, rel: "alternate", type: "text/markdown", href: loaderData!.markdownHref }] : []),
  ];
}

export async function action({ request, params }: Route.ActionArgs) {

  const retained = request.clone();
  try {
    assertSameOrigin(request);
    const form = await request.formData();
    // Suspended members may delete their own posts via requireMember. The rights to deletion and anonymization allow members to remove their posts at any time.
    // Soft deletion retains evidence in the DB. All other writes use requireWriter; suspended members go to /suspended.
    const deleting = formString(form, "intent") === "delete";
    const { user, db, profile } = deleting ? await requireMember(request) : await requireWriter(request);
    const threadId = parseId(params.id);
    const intent = formString(form, "intent");
    const context = { user, db, profile, request, form, threadId, intent };
    switch (intent) {
      case "intro-set": return await setTopicIntroduction(context);
      case "intro-unset": return await unsetTopicIntroduction(context);
      case "delete": return await deleteTopicEntry(context);
      case "flag": return await flagTopicEntry(context);
      case "report":
      case "report-details": return await reportTopicTranslation(context);
      case "draft": return await saveReplyDraft(context);
      // Native reply submissions have no intent field.
      case "":
      case "reply": return await postTopicReply(context);
      default: throw data("Bad request", { status: 400 });
    }
  }
  catch (error) {
    if (!(error instanceof MarkdownBusyError) && !(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const raw = readEntryForm(form);
    return data({ intent: "reply" as const, error: error instanceof SigningFailureResponse ? error.code : "busy", input: { body: raw.body, lang: raw.lang }, reported: false }, { status: error instanceof SigningFailureResponse ? error.status : 503, headers: error instanceof SigningFailureResponse ? { "Cache-Control": "private, no-store" } : { "Retry-After": "1" } });
  }

}

function EntryMeta({
  id,
  lang,
  langCode,
  handle,
  name,
  latin,
  avatar,
  createdAt,
  editedAt,
  historyTo,
  editTo,
  reader = false,
  readingLang,
  leading,
  controls,
}: {
  id?: string;
  reader?: boolean;
  readingLang?: Lang;
  lang: SourceLang;
  langCode?: string | null;
  handle: string;
  name?: string | null;
  latin?: string | null;
  avatar?: string | null;
  createdAt: Date;
  editedAt: Date | null;
  historyTo: string;
  // Return only to the author; also verify edit authorization server-side.
  editTo: string | null;
  // Before the name: the mark of a reply to a question (its named stance or objection).
  leading?: ReactNode;
  // A reply's translation status and switch name the original language, replacing the separate language note.
  controls?: ReactNode;
}) {
  return <div id={id}>
    <ListMeta items={[
      { key: "author", content: <>{avatar && <img src={avatar} alt="" className="member-avatar me-2 inline-block rounded" />}{leading}<AuthorLink handle={handle} name={name} latin={latin} reader={reader} byline /></> },
      !controls && lang !== readingLang && { key: "original", content: m.reading_lang_original({ name: languageLabel(lang, langCode) }) },
      { key: "posted", content: <span>{m.history_posted()} <LocalTime iso={createdAt.toISOString()} style="stamp" /></span> },
      editedAt && { key: "updated", content: <Link to={historyTo} className="underline">{m.history_updated()} <LocalTime iso={editedAt.toISOString()} style="stamp" /></Link> },
      !!controls && { key: "controls", content: controls },
      !!editTo && { key: "actions", content: <div className="inline-flex items-center gap-1 whitespace-nowrap align-middle">
        {editTo && <Link to={editTo} className="underline">{m.edit()}</Link>}
      </div> },
    ]} />
  </div>;
}

// Rebuild toggle state when the displayed version changes, such as a display-language change.
const displayKey = (id: number, d: EntryDisplay) => `${id}:${d.translation?.lang ?? "-"}:${d.shown}`;

// Placeholders for entries whose content is withheld: deleted posts, and hidden posts not visible to this viewer (only authors, assigned moderators, and operators see content).
function PlaceholderEntry({ entry }: { entry: Placeholder }) {
  return (
    <p className="ui-help text-muted-foreground italic">{entry.placeholder === "deleted" ? m.entry_deleted_placeholder() : m.entry_hidden_placeholder()}</p>
  );
}

function flagMessage(error: string | null): string {
  if (error === null) return m.flag_thanks();
  if (error === "rate_limited") return m.error_rate_limited();
  if (error === "duplicate") return m.flag_error_duplicate();
  if (error === "own_entry") return m.flag_error_own();
  if (error === "invalid_reason" || error === "invalid_note") return m.flag_error_invalid();
  return m.flag_error();
}

// Keep feedback beside the controls that submitted it, including error responses.
function ReportResult({ entryId, result }: { entryId: number; result: Route.ComponentProps["actionData"] }) {
  if (!result || (result.intent !== "flag" && result.intent !== "report") || result.entryId !== entryId) return null;
  return (
    <p role="status" className={result.reported ? "text-success" : "text-destructive"}>
      {result.intent === "flag" ? flagMessage(result.error) : result.reported ? m.report_thanks() : result.error === "rate_limited" ? m.error_rate_limited() : m.report_error()}
    </p>
  );
}

export default function Topic({ loaderData, actionData }: Route.ComponentProps) {
  const { topic, replies, defaultLang, page, hasNextPage, aiOpen, operator, question, stanceTag, writeTag, langParam, loadedAt, follow, canReply } = loaderData;
  const location = useLocation();
  const motionHistory = useMemo(() => ({ topicId: topic.id, entries: new Map<number, Set<string>>() }), [topic.id]);
  const returnTo = `${location.pathname}${location.search}`;
  const reportsRead = page === 1 && topic.placeholder === null && !topic.hidden;
  useEffect(() => {
    if (!reportsRead) return;
    let active = true, stop: (() => void) | undefined;
    void import("~/lib/translation-seen").then(module => {
      if (active) {
        stop = module.markTopicRead(returnTo);
      }
    }).catch(() => {});
    return () => { active = false; stop?.(); };
  }, [returnTo, reportsRead]);
  const [replyTarget, setReplyTarget] = useState(loaderData.replyTarget);
  // The author's language menu: languages whose translation has arrived since the page was read (TranslationWatch) are no longer muted.
  const [settled, setSettled] = useState<{ id: number; langs: Lang[] }>({ id: topic.placeholder === null ? topic.id : 0, langs: [] });
  const translating = loaderData.translating.filter(lang => !(settled.id === topic.id && settled.langs.includes(lang)));
  const quoteRoot = useRef<HTMLElement>(null);
  const [replyRound, setReplyRound] = useState(0);
  const hasReplyForm = canReply && !!loaderData.ownerId;
  useEffect(() => hasReplyForm ? afterPageIdle(startReplyFormLoad) : undefined, [hasReplyForm]);
  // The translation that the topic's "wrong translation" button is about (TranslatedEntry reports it, since the reader can switch to the original); the button is drawn in the end of the article, outside the entry.
  const [topicReported, setTopicReported] = useState(() => topic.placeholder === null ? initialReportedTranslation(topic.display) : null);
  const reportTopicTranslationChange = useCallback((reported: typeof topicReported) => {
    if (reported === topicReported) return;
    if (hasReplyForm) startReplyFormLoad();
    startTransition(() => setTopicReported(reported));
  }, [hasReplyForm, topicReported]);
  const settleTranslations = (langs: Lang[]) => {
    if (hasReplyForm) startReplyFormLoad();
    startTransition(() => setSettled(previous => ({
      id: topic.id,
      langs: [...new Set([...(previous.id === topic.id ? previous.langs : []), ...langs])],
    })));
  };
  const postedReply = replies.find(reply => reply.placeholder === null && reply.posted)?.id;
  const previousPostedReply = useRef(postedReply);
  useEffect(() => {
    if (postedReply !== undefined && postedReply !== previousPostedReply.current) {
      if (hasReplyForm) startReplyFormLoad();
      startTransition(() => setReplyRound(round => round + 1));
    }
    if (postedReply !== undefined) previousPostedReply.current = postedReply;
  }, [hasReplyForm, postedReply]);
  const replyFailed = actionData?.intent === "reply" && Boolean(actionData.error);
  // A real navigation replaces the target, including clearing it on the same URL.
  // Refused replies and fetcher revalidation preserve the target chosen by quoting.
  const resetReplyTarget = useEffectEvent(() => {
    if (replyFailed || replyTarget === loaderData.replyTarget) return;
    if (hasReplyForm) startReplyFormLoad();
    startTransition(() => setReplyTarget(loaderData.replyTarget));
  });
  useEffect(() => {
    resetReplyTarget();
  }, [loaderData.replyTarget?.id, loaderData.replyTarget?.href, loaderData.replyTarget?.handle, location.key, replyFailed]);
  useDropNoticeParams(loaderData.edited !== null || (topic.placeholder === null && topic.posted) || replies.some(r => r.placeholder === null && r.posted));
  const replyInput = actionData?.intent === "reply" && "input" in actionData ? actionData.input as { body: string; lang: string } : undefined;
  const readView = useMemo<ReplyReadView & { initializedDetails: Set<number> }>(() => ({ initializedDetails: new Set<number>() }), [topic.id, page]);
  const anchorView = useRef({ key: location.key, hash: location.hash, navigated: false });
  const replyById = useMemo(() => new Map(replies.map(r => [r.id, r])), [replies]);
  const displayedReplies = useMemo(() => loaderData.replyBranches
    ? loaderData.replyBranches.flatMap(branch => branch.replyIds.map(id => replyById.get(id)!))
    : replies, [replies, replyById, loaderData.replyBranches]);
  const selectQuotedReply = useEffectEvent((id: number) => {
    const reply = replies.find(r => r.id === id && r.placeholder === null && !r.hidden);
    if (reply && reply.placeholder === null) {
      if (hasReplyForm) startReplyFormLoad();
      startTransition(() => setReplyTarget({ id, href: `${location.pathname}${location.search}#c-${id}`, handle: reply.authorHandle }));
    }
  });
  const replyReadKey = displayedReplies.map(r => `${r.id}:${r.placeholder}:${r.placeholder === null && !r.hidden && !r.own}`).join(",");
  const markDisplayedReplies = useEffectEvent((mark: typeof import("~/lib/reply-read-marker").markNewReplies) => mark(topic.id, displayedReplies, readView));
  useEffect(() => {
    const root = quoteRoot.current;
    if (!canReply || !root) return;
    let cancelled = false;
    let started = false;
    let cleanup: (() => void) | undefined;
    const start = () => {
      if (started) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const body = element?.closest("[data-quote-entry]");
      if (!body || !root.contains(body) || !body.contains(range.endContainer)) return;
      started = true;
      void import("~/lib/quote-reply").then(({ attachQuoteReply }) => {
        if (cancelled) return;
        cleanup = attachQuoteReply(root, selectQuotedReply);
      });
    };
    document.addEventListener("selectionchange", start);
    root.addEventListener("pointerup", start);
    root.addEventListener("keyup", start);
    return () => {
      cancelled = true;
      document.removeEventListener("selectionchange", start);
      root.removeEventListener("pointerup", start);
      root.removeEventListener("keyup", start);
      cleanup?.();
    };
  }, [canReply, topic.id, page, location.pathname, location.search]);
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import("~/lib/reply-read-marker").then(({ markNewReplies }) => {
      if (!cancelled) cleanup = markDisplayedReplies(markNewReplies);
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [topic.id, replyReadKey, readView]);
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    if (anchorView.current.key !== location.key || anchorView.current.hash !== location.hash) {
      anchorView.current = { key: location.key, hash: location.hash, navigated: true };
    }
    const preserveInitialChoice = !anchorView.current.navigated;
    void import("~/lib/reply-branches-browser").then(({ attachReplyBranchAnchors }) => {
      const root = document.getElementById("replies");
      if (!cancelled && root) cleanup = attachReplyBranchAnchors(root, preserveInitialChoice);
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [topic.id, page, location.key, location.hash]);
  // One reply, in three rows: the name row (mark of a question's reply, name, time, translation status), the body, and the row of actions. The main actions (Insightful, Reply) are on the left in the ink;
  // the minor ones (wrong translation, report, delete, moderation) are on the right, small and grey, each a single press as before. The words drawn are short; the full phrases are read out.
  const renderReply = (r: typeof replies[number], suppressParent = false) => (
    <article key={r.id} id={`c-${r.id}`} className="relative space-y-2 border-t pt-3">
      {r.placeholder !== null ? (
        <PlaceholderEntry entry={r} />
      ) : (
        <>
          {r.parent && !suppressParent && <p className="ui-meta text-muted-foreground [overflow-wrap:anywhere]">
            {r.parent.state === "visible" ? <Link to={r.parent.href} className="underline">{m.reply_parent_link({ handle: r.parent.authorHandle })}</Link>
              : r.parent.state === "deleted" ? m.reply_parent_deleted() : m.reply_parent_unavailable()}
          </p>}
          {r.posted && <PostedTopicNotice topicId={r.id} lang={r.lang} langCode={r.langCode} firstPost={false} initial={loaderData.postedNotice?.langs ?? []} sourceStatus={loaderData.postedNotice?.sourceStatus} editHref={`/c/${r.id}/edit`} reply followed={loaderData.postedFollowed} />}
          {loaderData.edited === r.id && r.own && <PostedLine kind="edited" />}
          {r.hidden && <HiddenMark action={r.hiddenAction} />}
          <TranslatedEntry
            key={displayKey(r.id, r.display)}
            motionHistory={motionHistory.entries}
            initializedDetails={readView.initializedDetails}
            id={r.id}
            kind="reply"
            lang={r.lang} langCode={r.langCode}
            title={null}
            html={r.html}
            display={r.display}
            quotable={canReply && !r.hidden}
            quoteHandle={r.authorHandle}
            meta={(_info, controls) => (
              <EntryMeta
                id={`reply-meta-${r.id}`}
                readingLang={loaderData.displayLang}
                reader={loaderData.reader}
                lang={r.lang} langCode={r.langCode}
                handle={r.authorHandle}
                name={r.authorName}
                latin={r.authorNameLatin}
                avatar={r.avatarUrl}
                createdAt={r.createdAt}
                editedAt={r.editedAt}
                historyTo={`/c/${r.id}/history`}
                editTo={r.canEdit ? `/c/${r.id}/edit` : null}
                leading={r.stanceTag ? <><StanceTagLabel tag={r.stanceTag} />{" "}</> : undefined}
                controls={controls}
              />
            )}
            footer={(shown) => {
              const reportsTranslation = !loaderData.reader && !!shown;
              const reportsPost = !loaderData.reader && !r.own && !r.hidden;
              const minor = reportsTranslation || reportsPost || r.own || r.canModerate;
              return (
                <>
                  <div data-reply-actions="" className="reply-actions flex flex-wrap items-center gap-x-3 gap-y-1">
                    <EntryReactions compact entryId={r.id} reactions={r.reactions} canVote={!loaderData.reader && !r.own && !r.hidden} anchor={`#c-${r.id}`} loadedAt={loadedAt} reviewHref={r.reviewHref} />
                    {canReply && !r.hidden && <Link
                      to={replyTargetHref(location.pathname, location.search, r.id)}
                      className={cn(buttonVariants({ variant: "link" }), "touch-action h-auto px-0 font-medium ui-meta")}
                    >{m.reply_to_button()}</Link>}
                    {minor && <span aria-hidden="true" className="-mx-1.5 grow" />}
                    {reportsTranslation && <TranslationReportForm key={shown.lang} entryId={r.id} lang={shown.lang} kind="reply" reports={r.translationReports} />}
                    {reportsPost && <EntryReportForm entryId={r.id} anchor={`#c-${r.id}`} reported={r.reported || (actionData?.intent === "flag" && actionData.entryId === r.id && actionData.reported)} />}
                    {r.own && <DeleteEntryForm inline entryId={r.id} kind="reply" />}
                    {r.canModerate && <ModerationPanel className="min-w-0 open:basis-full" retainsReply entryId={r.id} hidden={r.hidden} returnTo={`${returnTo}#c-${r.id}`} canDelete={operator} />}
                  </div>
                  <ReportResult entryId={r.id} result={actionData} />
                </>
              );
            }}
          />
        </>
      )}
      {renderNushi(loaderData.nushi.entries[r.id])}
    </article>
  );
  // The end of the article, with reactions and secondary actions. The row has the main actions on the left (Insightful, Reply) and the minor ones on
  // the right. It closes the article. In a question the stance panel is the main thing to do, so Insightful stays under the question and the rest of the block follows the panels (the report button never sits above the stance).
  const renderNushi = (html?: string) => html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : null;

  const full = topic.placeholder === null ? topic : null;
  const asksQuestion = full !== null && question.asksStance;
  const reactions = full && <EntryReactions entryId={full.id} reactions={full.reactions} canVote={!loaderData.reader && !full.own && !full.hidden} anchor={`#p-${full.id}`} loadedAt={loadedAt} reviewHref={full.reviewHref} />;
  const reportsTranslation = !loaderData.reader && full !== null && topicReported !== null;
  const reportsPost = !loaderData.reader && full !== null && !full.own && !full.hidden;
  const articleEnd = full && (
    <section data-article-end="" className="space-y-3">
      <div data-article-actions="" className="reply-actions flex flex-wrap items-center gap-x-3 gap-y-1">
        {!asksQuestion && reactions}
        {(reportsTranslation || reportsPost || full.canModerate) && <span aria-hidden="true" className="-mx-1.5 grow" />}
        {reportsTranslation && <TranslationReportForm key={topicReported.lang} entryId={full.id} lang={topicReported.lang} kind="topic" hasTitle={full.title !== null} reports={full.translationReports} />}
        {reportsPost && <EntryReportForm entryId={full.id} anchor={`#p-${full.id}`} reported={full.reported || (actionData?.intent === "flag" && actionData.entryId === full.id && actionData.reported)} />}
        {full.canModerate && <ModerationPanel className="min-w-0 open:basis-full" entryId={full.id} hidden={full.hidden} returnTo={`${returnTo}#p-${full.id}`} canDelete={operator} />}
      </div>
      <div data-article-details="" className="relative flex flex-wrap items-center gap-x-4 gap-y-2 ui-meta text-muted-foreground">
        {full.editedAt && <Link to={`/t/${full.id}/history`} className="link-ui underline">{m.history_updated()} <LocalTime iso={full.editedAt.toISOString()} style="stamp" /></Link>}
        {full.canEdit && <Link to={`/t/${full.id}/edit`} className="link-ui underline">{m.edit()}</Link>}
        {full.own && <>
          <DeleteEntryForm inline entryId={full.id} kind="topic" />
          {!full.hidden && !question.asksStance && <Form method="post">
            <Button variant="link" type="submit" name="intent" value={loaderData.introSelected ? "intro-unset" : "intro-set"} className="h-auto px-0 ui-meta">
              {loaderData.introSelected ? m.intro_unset() : m.intro_set()}
            </Button>
          </Form>}
        </>}
        {loaderData.village && loaderData.village.kind !== "personal" && !loaderData.village.language && <Link to={`/v/${loaderData.village.slug}`} title={villageNameTitle(loaderData.village)} className="ui-meta underline">{villageName(loaderData.village)}</Link>}
        {follow && <FollowButton variant="compact" threadId={full.id} state={follow.state} returnTo={`${returnTo}#p-${full.id}`} />}
      </div>
      {loaderData.saved != null && <noscript className="reading-mobile-fallback">
        <SaveButton topicId={full.id} saved={loaderData.saved} returnTo={`${returnTo}#p-${full.id}`} />
      </noscript>}
      <ReportResult entryId={full.id} result={actionData} />
      {actionData?.intent === "intro" && actionData.error && <p role="alert">{entryErrorMessage(actionData.error)}</p>}
    </section>
  );
  return (
    <main ref={quoteRoot} className="reading-column reading-topic space-y-6">
      {loaderData.nushi.pending.length > 0 && <Suspense fallback={null}><NushiStatusWatches requestIds={loaderData.nushi.pending} /></Suspense>}
      {topic.placeholder !== null && <div className="flex justify-end">
        <OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} reader={loaderData.reader} />
      </div>}
      <article id={`p-${topic.id}`} className="space-y-2">
        {topic.placeholder !== null ? (
          <PlaceholderEntry entry={topic} />
        ) : (
          <>
            {topic.posted && loaderData.postedNotice && <PostedTopicNotice topicId={topic.id} lang={topic.lang} langCode={topic.langCode} place={loaderData.village ? postingVillageName(loaderData.village, topic.authorHandle) : undefined} firstPost={loaderData.postedNotice.first} initial={loaderData.postedNotice.langs} sourceStatus={loaderData.postedNotice.sourceStatus} materialWarning={loaderData.postedNotice.materialWarning} editHref={`/t/${topic.id}/edit`} />}
            {loaderData.edited === topic.id && topic.own && <PostedLine kind="edited" />}
            {topic.hidden && <HiddenMark action={topic.hiddenAction} />}
            {translating.length > 0 && <Suspense fallback={null}><TranslationWatch topicId={topic.id} onSettled={settleTranslations} /></Suspense>}
            <div className="reading-article-content space-y-2">
            <TranslatedEntry
              key={displayKey(topic.id, topic.display)}
              motionHistory={motionHistory.entries}
              initializedDetails={readView.initializedDetails}
              id={topic.id}
              kind="topic"
              lang={topic.lang} langCode={topic.langCode}
              title={topic.title}
              headline={topic.headline ?? undefined}
              html={topic.html}
              display={topic.display}
              reading={topic.reading}
              longTranslation={topic.longTranslation}
              readingLanguage={{ choice: loaderData.readingLanguage, translating: new Set(translating) }}
              readingActions={(readingLang, details) => {
                const actions = <TopicActions topicId={topic.id} originalLang={topic.lang} readingLang={readingLang}
                  details={details}
                  {...aiOpen} reader={loaderData.reader} saved={loaderData.saved} returnTo={returnTo} canReply={canReply} />;
                return { actions, actionMenu: <ReadingActionMenu>{actions}</ReadingActionMenu> };
              }}
              toolsBefore={question.asksStance && (
                <div className="contents">
                  <Badge variant="secondary" className="bg-info text-info-foreground">{m.question_badge()}</Badge>
                  {question.isAlt &&
                    (question.origin ? (
                      <Link to={`/t/${question.origin.id}${langParam ? `?lang=${langParam}` : ""}`} className="underline">
                        <TitledMessage message={m.alt_of_origin_link({ title: "{title}" })} title={question.origin.title.text} lang={question.origin.title.lang} />
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{m.alt_of_origin_unreadable()}</span>
                    ))}
                  {/* Lock from a received stance: show only to the author and permitted typo correctors. Omit the timestamp. */}
                  {question.locked && <span role="note" className="text-muted-foreground">{m.edit_locked_notice()}</span>}
                  {question.canFix && (
                    <span role="note" className="text-muted-foreground">
                      {m.edit_fix_notice()}{" "}
                      <Link to={`/t/${topic.id}/edit`} className="underline">
                        {m.edit_fix_link()}
                      </Link>
                    </span>
                  )}
                </div>
              )}
              quotable={canReply}
              quoteHandle={topic.authorHandle}
              meta={(info, controls, view, languageMenu) => (
                <>
                <ShareCardAddress topicId={topic.id} originalLang={topic.lang} readingLang={view.lang} />
                <div className="reading-byline" data-reading-byline="">
                  <div className="article-author">
                    <AuthorLink handle={topic.authorHandle} name={topic.authorName} latin={topic.authorNameLatin} reader={loaderData.reader} byline handleClassName="article-author-handle" />
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">
                    {loaderData.village && loaderData.village.kind !== "personal" && !loaderData.village.language && <Link to={`/v/${loaderData.village.slug}`} title={villageNameTitle(loaderData.village)} className="link-ui underline">{villageName(loaderData.village)}</Link>}
                    <LocalTime iso={topic.createdAt.toISOString()} style="date" />
                    {info && info.minutes >= 3 && <span data-reading-time="">{m.reading_minutes({ minutes: info.minutes })}</span>}
                    {languageMenu}
                    {topic.own && <>
                      {topic.canEdit && <Link to={`/t/${topic.id}/edit`} className="link-ui underline">{m.edit()}</Link>}
                      <DeleteEntryForm inline entryId={topic.id} kind="topic" />
                    </>}
                    <noscript className="reading-mobile-fallback"><a href={aiOpen.mdPath} className="link-ui underline">{m.open_in_ai_noscript()}</a></noscript>
                  </div>
                  {controls && <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 ui-meta text-muted-foreground" data-reading-language="">
                    {view.lang !== topic.lang && (view.aiUse ? <a href="/ai-use" title={view.title} className="link-ui underline">{view.text}</a> : <span title={view.title}>{view.text}</span>)}
                    {controls}
                  </div>}
                </div>
                </>
              )}
              onReportedChange={reportTopicTranslationChange}
              footer={() => <p className="article-signature" data-article-signature="">
                <AuthorLink handle={topic.authorHandle} name={topic.authorName} latin={topic.authorNameLatin} reader={loaderData.reader} byline handleClassName="article-author-handle" />
              </p>}
            />
            </div>
            {asksQuestion ? reactions : articleEnd}
          </>
        )}
      </article>
      {loaderData.aiMaterialLinks.map(link => <p className="ui-meta" key={link.href}><Link to={link.href} className="underline">{link.label}</Link></p>)}
      {renderNushi(loaderData.nushi.entries[topic.id])}
      {renderNushi(loaderData.nushi.controls)}
      {loaderData.askAi && <p className="ui-meta"><Link to={loaderData.askAi.href} className="underline">{loaderData.askAi.label}</Link></p>}
      {loaderData.reader && question.asksStance && <p className="ui-help text-muted-foreground">{m.public_reading_stances()}</p>}
      {question.asksStance && question.stance && topic.placeholder === null && (
        <section id="stance" className="space-y-2 rounded border p-3">
          <h2 className="text-lg font-semibold">{m.stance_title()}</h2>
          <StancePanel
            questionId={topic.id}
            stance={question.stance.stance}
            distribution={question.stance.distribution}
            peekHref={peekHrefFor(location.pathname, location.search, 1, "stance")}
            triggerEntryId={question.stance.triggerEntryId}
            message={question.stance.message}
            resumeChoice={loaderData.stanceResume}
            returnTo={stanceReturnTo(location.pathname, location.search, "stance")}
            canChoose={question.stance.canChoose}
          />
          {/* Tell authors that their own stance alone does not lock the question; the first stance from another member starts the lock. */}
          {topic.own && !question.locked && <p className="ui-meta text-muted-foreground">{m.stance_author_note()}</p>}
        </section>
      )}
      {question.reasons && <ReasonsPanel reader={loaderData.reader} questionId={topic.id} reasons={question.reasons} loadedAt={loadedAt} langParam={langParam} readingLang={loaderData.displayLang} />}
      {question.objections && <ObjectionsPanel reader={loaderData.reader} questionId={topic.id} panel={question.objections} langParam={langParam} />}
      {asksQuestion && articleEnd}
      <div className="reading-discussion space-y-6" data-reading-discussion="">
      <section id="replies" className="space-y-4">
        {loaderData.replyCount > 0 && <h2 className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-4 text-lg font-semibold">{m.home_replies({ count: loaderData.replyCount })}{loaderData.replyLangCount >= 2 && <>{" "}<span className="font-normal text-muted-foreground">{m.thread_reply_langs({ count: loaderData.replyLangCount })}</span></>}</h2>}
        {/* One line for moving through replies. The browser prepends the new-reply count and a link to the first new reply; empty, it takes no space. */}
        <div data-reply-summary="" className="flex flex-wrap items-center gap-x-3 gap-y-1 ui-meta empty:hidden">
          {loaderData.latestReplyHref && <Link to={loaderData.latestReplyHref} className="underline">{m.thread_latest_reply()}</Link>}
        </div>
        {question.asksStance && <RepliesFilter current={stanceTag} />}
        {stanceTag && replies.length === 0 && <p className="ui-help text-muted-foreground">{m.replies_filter_empty()}</p>}
        <Pagination page={page} hasNext={hasNextPage} lastPage={loaderData.pageCount} anchor="#replies" />
        <div data-reply-list="" className="space-y-6">
          {loaderData.replyBranches ? loaderData.replyBranches.map(branch => {
            const { shown, folded } = splitReplyBranch(branch.replyIds);
            const render = (id: number) => renderReply(replyById.get(id)!, branch.suppressParentIds.includes(id));
            const head = replyById.get(branch.replyIds[0])!;
            const rootLineId = `branch-root-${topic.id}-${page}-${branch.rootId}`;
            const labelId = branch.root ? rootLineId : head.placeholder === null ? `reply-meta-${head.id}` : `c-${head.id}`;
            return <div role="group" aria-labelledby={labelId} data-reply-branch={branch.rootId} key={branch.rootId} className="min-w-0 space-y-3">
              {branch.root && <p id={rootLineId} className="ui-meta text-muted-foreground [overflow-wrap:anywhere]">
                {branch.root.state === "visible" ? <Link to={branch.root.href} className="underline">{m.reply_parent_link({ handle: branch.root.authorHandle })}</Link>
                  : branch.root.state === "deleted" ? m.reply_parent_deleted() : m.reply_parent_unavailable()}
              </p>}
              {render(branch.replyIds[0])}
              {(shown.length > 0 || folded.length > 0) && <div className="ms-2 min-w-0 space-y-3 border-s ps-2 sm:ms-4 sm:ps-4">
                {shown.map(render)}
                {folded.length > 0 && <ReplyBranchTail key={`${topic.id}:${page}:${branch.rootId}`} openFor={branch.openFor} count={folded.length}>
                  {folded.map(render)}
                </ReplyBranchTail>}
              </div>}
            </div>;
          }) : replies.map(r => renderReply(r))}
        </div>
        <Pagination page={page} hasNext={hasNextPage} lastPage={loaderData.pageCount} anchor="#replies" />
      </section>
      <section id="reply" className={loaderData.reader ? "public-reading-end space-y-1 ui-help text-muted-foreground" : "border-t pt-4"}
        onPointerOver={hasReplyForm ? startReplyFormLoad : undefined}
        onPointerDownCapture={hasReplyForm ? startReplyFormLoad : undefined}
        onFocusCapture={hasReplyForm ? startReplyFormLoad : undefined}>
        {!loaderData.reader && <div className="flex flex-wrap items-center justify-between gap-2" data-reply-heading="">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold">{m.reply_write_title()}</h2>
            {loaderData.respondWithPost && <a href={loaderData.respondWithPost.formAction} className="ui-meta underline">{loaderData.respondWithPost.children}</a>}
          </div>
          {topic.placeholder === null && !topic.hidden && <OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} reader={loaderData.reader} sourceLang={topic.lang} readingLang={topicReported?.lang ?? topic.lang} showNoScript={false} />}
        </div>}
        {loaderData.reader && topic.placeholder === null && !topic.hidden && <>
          <p>{m.reading_end_intro()}</p>
          <p>{m.public_reading_reply()} <Link to={readerLoginHref(location.pathname, location.search)} className="underline">{m.login_title()}</Link></p>
        </>}
        {/* Hidden topics cannot receive replies; the server rejects them too. */}
        {(topic.placeholder !== null || topic.hidden) && <p className="ui-help text-muted-foreground">{m.reply_closed_hidden()}</p>}
        {/* Clear only after the member publishes a reply; revalidation preserves the editor. */}
        {canReply && loaderData.ownerId && (
          <Suspense fallback={<LoadClientReplyForm />}>
            <TopicReplyForm key={`${loaderData.ownerId}:${topic.id}:${replyRound}`} signatureRequired={loaderData.signPosts} respondWithPost={loaderData.respondWithPost}
              nushiAvailable={loaderData.nushiAvailable}
              owner={loaderData.ownerId} threadId={topic.id} keeper={{ scope: `reply:${topic.id}:${replyTarget?.id ?? ""}`, family: `reply:${topic.id}:`, startBody: "" }}
              error={actionData?.intent === "reply" ? actionData.error ?? undefined : undefined}
              defaultLang={defaultLang} defaultBody={replyInput?.body} selectedLang={replyInput?.lang}
              above={<>
                {replyTarget && <p className="flex flex-wrap gap-2 ui-meta [overflow-wrap:anywhere]">
                  <input type="hidden" name="parentId" value={replyTarget.id} />
                  <span>{replyTarget.handle ? m.reply_target_note({ handle: replyTarget.handle }) : m.reply_parent_unavailable()}</span>
                  {replyTarget.href && <Link to={replyTarget.href} className="underline">{m.reply_target_link()}</Link>}
                  <Link to={replyTargetHref(location.pathname, location.search, null)} className="underline">{m.reply_target_clear()}</Link>
                </p>}
                {/* Reply tags are selectable only on question replies; ?write=<tag> preselects one. Keyed by the mark of ?write=, so that following "Write a reason" on this same page
                    (a client-side navigation) chooses the mark; the text typed so far is kept. */}
                {question.asksStance && <StanceTagChips error={actionData?.intent === "reply" ? actionData.error ?? undefined : undefined} errorId="reply-error" key={writeTag ?? "none"} defaultValue={writeTag} />}
              </>}
              aiTools={{ ownerId: loaderData.ownerId, connectDraftLabel: loaderData.connectDraftLabel, kind: "reply", threadId: topic.id }}
            >
              {renderNushi(loaderData.nushi.reply)}
              {loaderData.replyToTopic && !replyTarget && <input type="hidden" name="parentId" value="" />}
            </TopicReplyForm>
          </Suspense>
        )}
      </section>
      <RelatedDiscussions id={topic.id} rows={loaderData.related.rows} omitted={loaderData.related.omitted} lang={langParam} />
      <TopicContinuation value={loaderData.continuation} lang={langParam} />
      </div>
    </main>
  );
}

// Marker for hidden posts displayed with content through moderation visibility, only for authors, assigned moderators, and operators.
function replyTargetHref(path: string, search: string, id: number | null) {
  const params = new URLSearchParams(search);
  params.set("reply_to", id === null ? "" : `c-${id}`);
  return `${path}?${params}#reply`;
}

function HiddenMark({ action }: { action: { id: number; reason: ReportReason } | null }) {
  return (
    <p role="note" className="flex flex-wrap items-baseline gap-x-3 rounded bg-notice px-2 py-1 ui-help text-notice-foreground">
      {m.entry_hidden_mark()}
      {action && (
        <>
          {" "}{m.notification_reason({ reason: reasonLabel(action.reason) })}{" "}
          <Link to={`/appeal/${action.id}`} className="underline">{m.notification_appeal()}</Link>
          {" "}<Link to="/notifications" className="link-ui">{m.notifications_title()}</Link>
        </>
      )}
    </p>
  );
}



// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}

export function shouldRevalidate({ formAction, currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) && currentUrl.href === nextUrl.href ? false : defaultShouldRevalidate;
}
