import { pushOpeningIds } from "~/lib/push/opening.server";
import { translationReportResultText } from "~/lib/translation-report-result-text";
import { namedAuthorLabel } from "~/lib/deleted-member";
import { groupChatNotifications } from "~/lib/group-chat-notifications";
import { groupThreadNotifications } from "~/lib/group-thread-notifications";
import { localizedLanguageLabel } from "~/lib/language-label";
import { getLocale } from "~/paraglide/runtime.js";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Button } from "~/components/ui/button";
import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/notifications";
import { PageHeader } from "~/components/page-header";
import { Pagination } from "~/components/pagination";
import { UnreadDot } from "~/components/unread";
import { LocalTime } from "~/components/local-time";
import { reasonLabel } from "~/components/reason-label";
import { requireMember } from "~/lib/auth/session.server";
import { displayLangFor, screenReadLangsFor } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { countUnreadNotifications, hasUnreadFollowedThread, listNotifications, markAllNotificationsRead } from "~/lib/notifications.server";
import { parsePage } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";
import { notificationHrefs } from "~/lib/notification-opening.server";
import { appealHref } from "~/lib/notifications";
import { villageName } from "~/lib/village-name";

// In-app notifications, newest first, 30 per page. Opening marks read; bulk marking remains available. Do not expose deleted or hidden post content.
// Suspended members may view and mark read; this is not posting.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.notifications_title() }];
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  await enforceMemberLimit(db, "notifications", user.id);
  const push = new URL(request.url).searchParams.get("push");
  const pushIds = push === null ? undefined : await pushOpeningIds(db, user.id, push);
  if (push !== null && !pushIds) throw data("Not found", { status: 404 });
  const result = await listNotifications(db, user.id, { ids: pushIds ?? undefined, page: parsePage(request), display: { readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile) }, typesetTitles: true, excerpts: true });
  const hrefs = await notificationHrefs(db, result.items);
  return {
    // Unread over all pages (the bell's number and the dot of new replies in followed posts): "nothing new" is said from this, not from the page on screen.
    unreadTotal: await countUnreadNotifications(db, user.id) + (await hasUnreadFollowedThread(db, user.id) ? 1 : 0),
    homeArea: profile.homeArea,
    page: result.page,
    hasNext: result.hasNext,
    items: await Promise.all(
      result.items.map(async (n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
        until: n.until ? n.until.toISOString().slice(0, 10) : null,
        // Followed topics start at the first unread reply, with the same fallback as mail and cards.
        href: hrefs.get(n.id) ?? null,
      })),
    ),
  };
}

export async function action({ request }: Route.ActionArgs) {
  // Reject changes from cross-site POSTs (CSRF), checking before authentication or input parsing (csrf.server.ts convention).
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  await enforceMemberLimit(db, "notifications", user.id);
  const form = await request.formData();
  const intent = formString(form, "intent");
  if (intent === "read-all") {
    await markAllNotificationsRead(db, user.id);
  } else {
    throw data("Bad request", { status: 400 });
  }
  // Return to the same page, preserving ?page=.
  const page = formString(form, "page");
  throw redirect(/^[1-9]\d{0,5}$/.test(page) && page !== "1" ? `/notifications?page=${page}` : "/notifications");
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { page, hasNext } = loaderData;
  const items = groupThreadNotifications(groupChatNotifications(loaderData.items));
  const unread = items.some((n) => !n.read);
  return (
    <main className="space-y-4">
      <PageHeader
        title={m.notifications_title()}
        actions={<>
          <Link to="/settings#settings-email" className="ui-meta link-ui text-muted-foreground">{m.notifications_email_settings()}</Link>
          {unread && <Form method="post">
            <input type="hidden" name="intent" value="read-all" />
            <input type="hidden" name="page" value={page} />
            <Button type="submit" className="text-sm" variant="outline">
              {m.notifications_mark_all()}
            </Button>
          </Form>}
        </>}
      />
      {items.length === 0 && <p>{m.notifications_empty()}</p>}
      {loaderData.unreadTotal === 0 && items.length > 0 && <p className="ui-help text-muted-foreground">{m.notifications_all_read()}</p>}
      <ul className="divide-y">
        {items.map((n) => {
          const grouped = n.threadSize > 1;
          const others = n.threadHandles.length - 2;
          const handles = n.threadHandles.slice(0, 2).map(handle => `@${handle}`).join(", ");
          const from = n.entryLang && n.entryLang !== loaderData.homeArea ? m.notification_from_lang({ language: localizedLanguageLabel(n.entryLang, getLocale()) }) : null;
          return <li key={n.id} id={`n-${n.id}`} className={`space-y-1 py-3 ${n.read ? "text-muted-foreground" : "font-medium"}`}>
            <div>
              {!n.read && <UnreadDot label={m.notification_unread()} className="me-2" />}
              {grouped
                ? <OpenNotification id={n.threadOldestId} group>{n.topicTitle || m.headline_empty()}</OpenNotification>
                : n.href ? <OpenNotification id={n.id}><NotificationText n={n} homeArea={loaderData.homeArea} handles={n.chatHandles} count={n.chatCount} /></OpenNotification> : <NotificationText n={n} homeArea={loaderData.homeArea} handles={n.chatHandles} count={n.chatCount} />}
              {grouped && <span className="block font-normal text-muted-foreground">{!n.threadHandles.length ? m.notification_thread_new() : n.threadMentionsOnly ? (others > 0 ? m.notification_thread_mentioned_more({ handles, others }) : m.notification_thread_mentioned({ handles })) : others > 0 ? m.notification_thread_replied_more({ handles, others }) : m.notification_thread_replied({ handles })}</span>}
              </div>
            {n.excerpt && <p className="line-clamp-1 ui-help font-normal text-muted-foreground" lang={n.excerptLang ?? undefined}>{n.excerpt}</p>}
            <div className="flex flex-wrap items-center gap-3 ui-meta font-normal text-muted-foreground">
              <LocalTime iso={n.createdAt} />
              {from && (grouped || (n.kind !== "reply_to_topic" && n.kind !== "reply_to_reply")) && <span>{from}</span>}
              {/* Only appealable actions (hide, delete, suspend, or exclude stances and 「なるほど」) and appeal outcomes. */}
              {appealHref(n) && <OpenNotification id={n.id} target="appeal">{n.kind === "moderation" ? m.notification_appeal() : m.notification_open()}</OpenNotification>}
            </div>
          </li>;
        })}
      </ul>
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}

function OpenNotification({ id, target, group, children }: { id: number; target?: "appeal"; group?: boolean; children: React.ReactNode }) {
  return <Link reloadDocument to={`/notifications/${id}/open${target ? "?target=appeal" : group ? "?group=thread" : ""}`} className="link-ui">{children}</Link>;
}

type Item = Route.ComponentProps["loaderData"]["items"][number];

function NotificationText({ n, homeArea, handles, count }: { n: Item; homeArea: string; handles: string[]; count: number }) {
  if (n.kind === "translation_report_result") return <>{n.unavailable || !n.translationResult ? m.notification_content_unavailable() : translationReportResultText(n.translationResult, n.topicTitle, getLocale())}</>;
  if (n.kind === "chat_mention" && n.chat) return <span title={n.chat.originalName}>{handles.length ? m.notification_chat_authors({ handles: handles.map(handle => `@${handle}`).join(", "), name: villageName(n.chat) }) : m.notification_chat_anonymous({ name: villageName(n.chat) })}{count > 1 && <> {m.notification_chat_count({ count })}</>}</span>;
  if (n.kind === "village_invite" || n.kind === "village_removed" || n.kind === "village_owner_changed" || n.kind === "village_added") {
    if (!n.village) return <>{m.village_error_unavailable()}</>;
    const name = villageName(n.village);
    const original = n.village.originalName;
    if (n.kind === "village_owner_changed") return <span title={original}>{m.notification_village_owner_changed({ name })}</span>;
    if (n.kind === "village_added") return <span title={original}>{m.notification_village_added({ name, actor: namedAuthorLabel(n.actorHandle, n.actorName) })}</span>;
    if (n.kind === "village_removed") return <><span title={original}>{m.notification_village_membership_ended({ name })}</span>{n.village.reason && <> {m.notification_village_membership_reason({ reason: n.village.reason })}</>}</>;
    return <><span title={original}>{n.village.inviteKind === "owner" ? m.notification_village_owner({ handle: n.actorHandle ?? "?", name }) : m.notification_village_invite({ handle: n.actorHandle ?? "?", name })}</span>{!n.village.pending && <> {m.notification_village_inactive()}</>}</>;
  }
  if (n.kind === "mention") {
    if (n.unavailable) return <>{m.notification_mention_unavailable()}</>;
    return <>{m.notification_mention({ handle: n.actorHandle ?? "?", title: n.topicTitle || m.headline_empty() })}</>;
  }
  if (n.kind === "response_to_topic") {
    return <>{n.unavailable ? m.notification_content_unavailable() : m.notification_response_to_topic({ handle: n.actorHandle ?? "?", title: n.topicTitle || m.headline_empty() })}</>;
  }
  if (n.kind === "reply_to_topic" || n.kind === "reply_to_reply") {
    if (n.unavailable) return <>{m.notification_reply_unavailable()}</>;
    const handle = n.actorHandle ?? "?";
    const title = n.topicTitle || m.headline_empty();
    if (n.entryLang && n.entryLang !== homeArea) {
      const language = localizedLanguageLabel(n.entryLang, getLocale());
      return <>{n.kind === "reply_to_topic" ? m.notification_reply_to_topic_language({ handle, title, language }) : m.notification_reply_to_reply_language({ handle, title, language })}</>;
    }
    return n.kind === "reply_to_topic" ? (
      <>{m.notification_reply_to_topic({ handle, title: n.topicTitle || m.headline_empty() })}</>
    ) : (
      <>{m.notification_reply_to_reply({ handle, title: n.topicTitle || m.headline_empty() })}</>
    );
  }
  if (n.kind === "followed_thread") {
    if (n.unavailable) return <>{m.notification_content_unavailable()}</>;
    // The latest reply is hidden or deleted but the topic can be read: no author, and the link goes to the topic.
    return n.latestUnavailable ? (
      <>{m.notification_followed_thread_nolatest({ count: n.count, title: n.topicTitle || m.headline_empty() })}</>
    ) : (
      <>{m.notification_followed_thread({ count: n.count, title: n.topicTitle || m.headline_empty(), handle: n.actorHandle ?? "?" })}</>
    );
  }
  if (n.kind === "moderation" && n.automatic) return <>{m.notification_moderation_automatic()}</>;
  if (n.kind === "moderation" && (n.action === "hide_chat" || n.action === "unhide_chat")) return <>{n.action === "hide_chat" ? m.notification_moderation_hide_chat() : m.notification_moderation_unhide_chat()}{n.reason && <> {m.notification_reason({ reason: reasonLabel(n.reason) })}</>}</>;
  if (n.kind === "moderation" && (n.action === "fix_village" || n.action === "end_village" || n.action === "unfix_village" || n.action === "reopen_village")) {
    return <>{n.action === "fix_village" ? m.notification_moderation_fix_village() : n.action === "end_village" ? m.notification_moderation_end_village() : n.action === "unfix_village" ? m.notification_moderation_unfix_village() : m.notification_moderation_reopen_village()}
      {n.village && <> {villageName(n.village)}</>}
      {(n.action === "fix_village" || n.action === "end_village") && n.reason && <> {m.notification_reason({ reason: reasonLabel(n.reason) })}</>}
      {(n.action === "fix_village" || n.action === "end_village") && n.note && <> {m.notification_note({ note: n.note })}</>}
    </>;
  }
  if (n.kind === "moderation") {
    // Reversals and revocations omit the reason category.
    if (n.action === "unsuspend" || n.action === "include_reactions") {
      return (
        <>
          {n.action === "unsuspend" ? m.notification_moderation_unsuspend() : m.notification_moderation_include()}
          {n.note && <> {m.notification_note({ note: n.note })}</>}
        </>
      );
    }
    return (
      <>
        {n.action === "suspend"
          ? m.notification_moderation_suspend({ until: n.until ?? "" })
          : n.action === "delete"
            ? m.notification_moderation_delete()
            : n.action === "restore_village_icon"
              ? m.log_village_icon_restored()
            : n.action === "clear_village_icon"
              ? m.log_village_icon_removed()
            : n.action === "clear_avatar"
              ? m.notification_avatar_removed()
            : n.action === "clear_display_name"
              ? m.notification_display_name_removed()
              : n.action === "exclude_reactions"
              ? m.notification_moderation_exclude()
              : n.action === "fix_entry"
                ? m.notification_moderation_fix()
                : m.notification_moderation_hide()}
        {n.reason && <> {m.notification_reason({ reason: reasonLabel(n.reason) })}</>}
        {n.note && <> {m.notification_note({ note: n.note })}</>}
      </>
    );
  }
  if (n.kind === "appeal_decided") {
    return (
      <>
        {n.appealStatus === "overturned"
          ? n.appealReversed === false
            ? m.notification_appeal_overturned_nochange()
            : m.notification_appeal_overturned()
          : m.notification_appeal_upheld()}
        {n.decisionNote && <> {m.notification_note({ note: n.decisionNote })}</>}
      </>
    );
  }
  return <>{m.notification_generic()}</>;
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
