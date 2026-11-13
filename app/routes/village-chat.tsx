import { withVillageIcons } from "~/lib/village-icon.server";
import { createChatTranslationReport, ChatTranslationReportError } from "~/lib/chat-translation-reports.server";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { ChatReportError, createChatReport } from "~/lib/village-chat-reports.server";
import { ChatReportForm } from "~/components/chat-report-form";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { data, Form, Link, redirect, useNavigate, useNavigation, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/village-chat";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { CHAT_BODY_MAX, chatSequence, chatReplyExcerpt, chatReplyFromMessage, type ChatReply, type ActiveChatMessage } from "~/lib/village-chat";
import { acceptChatConsent, ChatError, chatPage, markChatRead, mutateChat } from "~/lib/village-chat.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { useVillageChat } from "~/lib/use-village-chat";
import { villageName } from "~/lib/village-name";
import { Button } from "~/components/ui/button";
import { MentionTextarea } from "~/components/mention-autocomplete";
import { m } from "~/paraglide/messages.js";
import { displayLangFor, langQueryParam, screenReadLangsFor, villageReaderFor } from "~/lib/display-lang.server";
import { localizeVillage } from "~/lib/village-translations.server";
import { ChatReplyLine } from "~/components/chat-reply";
import { ChatMessageView } from "~/components/chat-message";
import { VillageHeader } from "~/components/village-header";
import { useChatPosition } from "~/lib/use-chat-position";
import { chatDay, chatDayLabel, groupChatMessage, type ChatCalendar } from "~/lib/chat-calendar";
import { getLocale } from "~/paraglide/runtime.js";
import { afterInitialActivation } from "~/lib/initial-activation";
import type { loader as memberLoader } from "./member-layout";
import { useNavigationUnread } from "~/lib/navigation-unread";
import { countUnreadNotifications } from "~/lib/notifications.server";
import { chatUnreadCounts } from "~/lib/village-chat.server";
import { useChatNavigation } from "~/components/site-navigation";
import { ArrowDown } from "lucide-react";
import { ChatConsentNotice } from "~/components/chat-consent-notice";
import { noticesAvailable } from "~/lib/notices.server";

export const middleware = [privateCacheMiddleware];
export function headers({ actionHeaders }: Route.HeadersArgs) {
  const headers = new Headers(CHAT_PRIVATE_HEADERS);
  const noticesRead = actionHeaders.get("X-Chat-Read-Notices");
  if (noticesRead) headers.set("X-Chat-Read-Notices", noticesRead);
  for (const name of ["X-Chat-Unread-Counts", "X-Unread-Notifications"]) {
    const value = actionHeaders.get(name); if (value) headers.set(name, value);
  }
  return headers;
}
export const handle = { chat: true };
export function meta({ loaderData: page }: Route.MetaArgs) { return [{ title: page && !("unavailable" in page) ? `${villageName(page.village)} · ${m.village_chat_title()}` : m.village_chat_title() }, { name: "robots", content: "noindex" }]; }
export async function loader({ request, params }: Route.LoaderArgs) {
  if (!villageChatEnabled()) throw data("Not found", { status: 404 });
  const { db, user, profile } = await requireMember(request);
  const search = new URL(request.url).searchParams;
  const before = search.has("before") ? chatSequence(search.get("before")) : undefined;
  const after = search.has("after") ? chatSequence(search.get("after")) : undefined;
  if (after === null || before !== undefined && after !== undefined || before === null) throw data("Bad request", { status: 400 });
  const linkLang = langQueryParam(request);
  const page = await chatPage(db, user.id, params.slug, { before, after, at: search.get("report") ?? search.get("at") ?? undefined, unread: !search.has("latest"), topics: { displayLang: displayLangFor(request, profile), readLangs: screenReadLangsFor(request, profile), langParam: linkLang } });
  if (!page) {
    if (search.has("at")) return data({ unavailable: true as const }, { status: 404, headers: CHAT_PRIVATE_HEADERS });
    throw redirect(`/v/${params.slug}`);
  }
  const report = search.get("report");
  if (report && (page.consentRequired || !page.messages.some(message => !message.deleted && !message.hidden && !message.own && message.id === report))) throw data("Not found", { status: 404 });
  // The name in the reader's language when the village was named in another (its original stays in the tooltip of the head).
  return { ...page, targetUnavailable: page.consentRequired ? search.has("at") : page.targetUnavailable, privacyAvailable: page.consentRequired && noticesAvailable().privacy, village: (await withVillageIcons(db, [await localizeVillage(db, page.village, villageReaderFor(request, profile))]))[0], linkLang, report, reported: search.get("reported"), now: Date.now(), latest: search.has("latest"), window: `${search.get("before") ?? ""}:${search.get("at") ?? ""}:${search.get("after") ?? ""}` };
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (!villageChatEnabled()) throw data("Not found", { status: 404 });
  const form = await request.formData();
  const intent = form.get("intent");
  const readingOrDeleting = intent === "read" || intent === "delete" || intent === "consent";
  const { db, user } = readingOrDeleting ? await requireMember(request) : await requireWriter(request);
  if (!["send", "edit", "delete", "read", "flag", "translation-report", "consent"].includes(String(intent))) throw data("Bad request", { status: 400 });
  const limits = intent === "send" ? ["chat-send-minute", "chat-send-hour"] as const : [intent === "edit" ? "chat-edit" : intent === "delete" ? "chat-delete" : intent === "flag" ? "report" : "chat-read"] as const;
  for (const rule of limits) {
    const rate = await hitMemberLimit(db, rule, user.id);
    if (!rate.allowed) return data({ error: "limit" }, { status: 429, headers: rateLimitHeaders(rate) });
  }
  try {
    if (intent === "translation-report") {
      const messageId = form.get("id");
      if (typeof messageId !== "string" || !/^[a-f0-9]{32}$/.test(messageId)) throw new ChatTranslationReportError("invalid");
      await createChatTranslationReport(db, user.id, { slug: params.slug, messageId, lang: form.get("lang"), note: form.get("note") });
      return data({ translationReported: true }, { headers: CHAT_PRIVATE_HEADERS });
    }
    if (intent === "flag") {
      const messageId = form.get("id");
      if (typeof messageId !== "string" || !/^[a-f0-9]{32}$/.test(messageId)) throw new ChatReportError("invalid");
      await createChatReport(db, user.id, { slug: params.slug, messageId, reason: form.get("reason"), note: form.get("note") });
      return redirect(`/v/${params.slug}/chat?at=${messageId}&reported=${messageId}#chat-${messageId}`);
    }
    if (intent === "consent") {
      await acceptChatConsent(db, user.id, params.slug, form.get("version"));
    } else if (intent === "read") {
      const seq = chatSequence(form.get("seq"));
      if (seq === null) throw new ChatError("invalid");
      const cleared = await markChatRead(db, user.id, params.slug, seq);
      if (form.get("background") === "1") {
        const [unread, notifications] = await Promise.all([chatUnreadCounts(db, user.id, { excludeEnded: true }), countUnreadNotifications(db, user.id)]);
        return data({ ok: true, unreadCounts: Object.fromEntries(unread), notifications }, { headers: {
          "X-Chat-Read-Notices": cleared > 0 ? "1" : "0", "X-Chat-Unread-Counts": JSON.stringify(Object.fromEntries(unread)), "X-Unread-Notifications": String(notifications),
        } });
      }
    } else {
      const result = await mutateChat(db, user.id, params.slug, intent as "send" | "edit" | "delete", { body: form.get("body"), id: form.get("id"), replyToId: form.get("replyToId") });
      if (intent === "send") return redirect(`/v/${params.slug}/chat?latest=1#chat-${result.id}`);
    }
  } catch (error) {
    if (error instanceof ChatTranslationReportError) return data({ error: error.code }, { status: error.code === "unavailable" ? 503 : error.code === "not_found" ? 404 : error.code === "limit" ? 429 : error.code === "duplicate" ? 409 : 400, headers: CHAT_PRIVATE_HEADERS });
    if (error instanceof ChatReportError) {
      if (error.code === "not_found") throw data("Not found", { status: 404 });
      return data({ error: error.code }, { status: error.code === "unavailable" ? 503 : error.code === "duplicate" ? 409 : 400 });
    }
    if (!(error instanceof ChatError)) throw error;
    if (error.code === "not_found") throw data("Not found", { status: 404 });
    return data({ error: error.code }, { status: ["invalid", "invalid_reply"].includes(error.code) ? 400 : 403 });
  }
  const url = new URL(request.url);
  url.searchParams.delete("_routes");
  return redirect(`/v/${params.slug}/chat${url.search}`);
}

export default function VillageChat({ loaderData, actionData }: Route.ComponentProps) {
  if ("unavailable" in loaderData) return <main><p role="status">{m.village_chat_reply_destination_unavailable()}</p></main>;
  if (loaderData.consentRequired) {
    return <main className="mx-auto max-w-3xl space-y-4 [overflow-wrap:anywhere]">
      <VillageHeader village={loaderData.village} current="chat" chat={{ joined: true, unread: 0 }} />
      <ChatReaders village={loaderData.village} count={loaderData.readers} />
      {loaderData.targetUnavailable && <p role="status">{m.village_chat_reply_destination_unavailable()}</p>}
      <ChatConsentNotice privacyAvailable={loaderData.privacyAvailable} previousVersion={loaderData.previousConsentVersion} />
      {actionData && "error" in actionData && <p role="alert">{actionData.error === "limit" ? m.village_chat_limit() : actionData.error === "invalid" ? m.village_chat_consent_changed() : m.village_chat_read_only()}</p>}
      <Form method="post"><input type="hidden" name="version" value={loaderData.consentVersion} /><Button type="submit" name="intent" value="consent">{m.village_chat_consent_accept()}</Button></Form>
    </main>;
  }
  return <ConsentedChat key={loaderData.village.slug} loaderData={loaderData} actionData={actionData} />;
}

function ConsentedChat({ loaderData, actionData }: {
  loaderData: Extract<Route.ComponentProps["loaderData"], { consentRequired: false }>;
  actionData: Route.ComponentProps["actionData"];
}) {
  const slug = loaderData.village.slug!;
  const member = useRouteLoaderData<typeof memberLoader>("routes/member-layout");
  const self = member && !member.reader ? member.handle : "";
  const initialUnread = Object.fromEntries(member && !member.reader && "villages" in member ? member.villages.map(v => [v.slug!, v.unread ?? 0]) : []);
  const snapshot = useMemo(() => ({ ...loaderData, unreadCounts: initialUnread }), [loaderData, member]);
  const { noteSend, reconnecting, messages, deleted, readLimit, gaps, loadGap, loadingGap, gapError, ended, hasNewer, before, loadOlder, loadingOlder, historyError, unreadAfter, loadNewer, loadingNewer, unreadCounts, updateUnreadCounts, refresh } = useVillageChat(slug, snapshot, loaderData.linkLang);
  const [boundary] = useState(() => loaderData.messages.filter(message => !message.deleted).find(message => !message.own && !message.hidden && message.createdSeq > loaderData.readSeq)?.createdSeq);
  const lastSeq = messages.at(-1)?.createdSeq ?? 0;
  const windowHref = (key: "before" | "after" | "latest", seq: number) => `?${new URLSearchParams({ [key]: String(seq), ...(loaderData.linkLang ? { lang: loaderData.linkLang } : {}) })}`;
  const composer = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const updateNavigation = useNavigationUnread();
  const onRead = useCallback((counts: { notifications: number; unreadCounts: Record<string, number> }) => {
    updateUnreadCounts(counts.unreadCounts);
    updateNavigation?.(counts);
  }, [updateUnreadCounts, updateNavigation]);
  const position = useChatPosition({ slug, messages, boundary, readSeq: loaderData.readSeq, readLimit, before, loadOlder, loadingOlder, loadNewer, loadingNewer, loadGap, hasNewer, seq: loaderData.seq, composerHeight, onRead });
  const unread = unreadCounts[slug] ?? 0;
  // Keep a confirmed zero while following arrivals; gaps and failed receipts expose the server count.
  const [followingRead, setFollowingRead] = useState(false);
  useLayoutEffect(() => {
    if (!position.atBottom || readLimit < lastSeq || position.readFailed) setFollowingRead(false);
    else if (unread === 0) setFollowingRead(true);
  }, [position.atBottom, position.readFailed, readLimit, lastSeq, unread]);
  const readThroughEnd = followingRead && position.atBottom && readLimit >= lastSeq && !position.readFailed;
  useChatNavigation(slug, unreadCounts, readThroughEnd);
  const newMessageCount = position.newCount + (hasNewer ? unreadAfter : 0);
  const [originals, setOriginals] = useState(false);
  // The switch is only for a window that has a message in another language shown by its translation.
  const hasTranslations = messages.some(message => message.translation?.state === "ready" && message.translation.text !== null);
  const [calendar, setCalendar] = useState<ChatCalendar>({ timeZone: null, locale: getLocale(), now: loaderData.now });
  useEffect(() => afterInitialActivation(() => setCalendar({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: getLocale(), now: Date.now() })), []);
  const [report, setReport] = useState<string | null>(loaderData.report);
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  const reportLink = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const openReport = useCallback((id: string) => { reportLink.current = document.activeElement as HTMLElement; setReport(id); }, []);
  const closeReport = () => setReport(null);
  const [activeMessage, setActiveMessage] = useState<string | null>(null);
  const focusedMessage = messages.some(message => message.id === activeMessage) ? activeMessage : messages[0]?.id;
  const activateMessage = useCallback((id: string) => setActiveMessage(id), []);
  const days = useMemo(() => new Map(messages.map(message => [message.id, chatDay(message.createdAt, calendar)])), [messages, calendar]);
  const gapsBySequence = useMemo(() => new Map(gaps.map(gap => [gap.before, gap])), [gaps]);
  useEffect(() => {
    const element = composer.current;
    if (!element) return;
    const viewport = window.visualViewport;
    const previousScrollPadding = document.documentElement.style.scrollPaddingBottom;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      setComposerHeight(height); document.documentElement.style.scrollPaddingBottom = `${height}px`;
    };
    const adjust = () => {
      const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      element.style.bottom = `${inset}px`;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure(); adjust();
    viewport?.addEventListener("resize", adjust); viewport?.addEventListener("scroll", adjust); window.addEventListener("resize", adjust);
    return () => {
      observer.disconnect(); viewport?.removeEventListener("resize", adjust); viewport?.removeEventListener("scroll", adjust); window.removeEventListener("resize", adjust);
      document.documentElement.style.scrollPaddingBottom = previousScrollPadding;
    };
  }, [ended]);
  const sendForm = useRef<HTMLFormElement>(null);
  const [reply, setReply] = useState<ActiveChatMessage | null>(null);
  const replyTarget = messages.find(message => message.id === reply?.id) ?? reply;
  const pendingReply = useRef<ActiveChatMessage | null>(null);
  const chooseReply = useCallback((message: ActiveChatMessage) => {
    setReply(message);
    sendForm.current?.querySelector("textarea")?.focus();
  }, [setReply]);
  const navigation = useNavigation();
  const submission = useRef<{ intent: string; id: string } | null>(null);
  const sendingGuard = useRef(false);
  const [sending, setSending] = useState(false);
  // The message just sent is shown at once, in a lighter ink, until the server has taken it (then the real one takes its place) or has refused it.
  const [pending, setPending] = useState<{ body: string; reply: ChatReply | null } | null>(null);
  // A message that did not get through goes back into the box (in front of anything typed since), so that nothing written is lost: "failed" when the server refused it,
  // "unconfirmed" when another navigation cut the send short and the list does not show it afterwards.
  const [restored, setRestored] = useState<null | "failed" | "unconfirmed">(null);
  const pendingBody = useRef("");
  // The newest message the screen had when the message was sent, how far the send had got when it was cut short, and what is waiting to be checked against the list.
  const sentAfter = useRef(0);
  const sendPhase = useRef<"submitting" | "loading" | null>(null);
  const unconfirmed = useRef<{ body: string; after: number; reply: ActiveChatMessage | null } | null>(null);
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  // Puts the message that was just sent back into the box, in front of anything typed since, and drops the "sending" line.
  const restoreSent = (kind: "failed" | "unconfirmed" = "failed") => {
    const field = sendForm.current?.querySelector("textarea");
    if (field && pendingBody.current) { field.value = field.value.trim() ? `${pendingBody.current}\n${field.value}` : pendingBody.current; grow(field); }
    setReply(old => old ?? pendingReply.current);
    pendingBody.current = "";
    setPending(null); setRestored(kind);
  };
  useEffect(() => {
    if (navigation.state !== "idle") {
      const intent = navigation.formData ? String(navigation.formData.get("intent")) : null;
      // Another navigation (an edit, a delete, a report, the link to the newest messages) cuts the send short and its answer never comes. The server has often taken the message
      // all the same, so nothing is put back at once: once the screen is settled, the list is looked at, and the message goes back into the box only if it is not there.
      // A send already at the stage of going to the newest messages has been saved, and needs no check.
      if (submission.current?.intent === "send" && intent !== "send") {
        if (sendPhase.current !== "loading") unconfirmed.current = { body: pendingBody.current, after: sentAfter.current, reply: pendingReply.current };
        pendingBody.current = ""; setPending(null);
        submission.current = null; sendingGuard.current = false; setSending(false);
      }
      if (navigation.formData) {
        submission.current = { intent: String(navigation.formData.get("intent")), id: String(navigation.formData.get("id") ?? "") };
        if (intent === "send") sendPhase.current = navigation.state === "loading" ? "loading" : "submitting";
      }
    } else if (submission.current) {
      if (submission.current.intent === "send" && actionData && "error" in actionData) restoreSent();
      if (!actionData || !("error" in actionData)) {
        if (submission.current.intent === "send") { position.latest(); requestAnimationFrame(() => requestAnimationFrame(() => setPending(null))); }
        if (submission.current.intent === "edit") {
          const details = document.getElementById(`chat-${submission.current.id}`)?.querySelector("details");
          if (details) details.open = false;
        }
        if (submission.current.intent === "flag") setReport(null);
      }
      submission.current = null; sendingGuard.current = false; setSending(false);
    }
  }, [navigation.state, navigation.formData, actionData, position.latest]);
  const restoreLater = useRef(restoreSent);
  restoreLater.current = restoreSent;
  useEffect(() => {
    if (navigation.state !== "idle" || !unconfirmed.current) return;
    const timer = setTimeout(() => {
      const waiting = unconfirmed.current;
      unconfirmed.current = null;
      if (!waiting || !waiting.body.trim()) return;
      const text = waiting.body.trim();
      // The same words from this member, newer than what the screen had when it was sent: the server took it.
      if (latestMessages.current.some(message => message.own && message.createdSeq > waiting.after && message.parts.map(part => part.text).join("").trim() === text && (message.reply?.id ?? null) === (waiting.reply?.id ?? null))) return;
      pendingReply.current = waiting.reply;
      pendingBody.current = waiting.body;
      restoreLater.current("unconfirmed");
    }, 1500);
    return () => clearTimeout(timer);
  }, [navigation.state]);
  const grow = (element: HTMLTextAreaElement) => {
    element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  };
  useEffect(() => {
    const form = sendForm.current;
    const reset = () => requestAnimationFrame(() => { const field = form?.querySelector("textarea"); if (field) grow(field); });
    form?.addEventListener("reset", reset); return () => form?.removeEventListener("reset", reset);
  }, []);
  const renderGap = (gap: typeof gaps[number]) => <div key={gap.after} data-chat-gap className="my-3 space-y-2">
    <hr />
    <Link to={windowHref("after", gap.after)} className="block underline ui-meta" aria-disabled={loadingGap !== null} onClick={event => { event.preventDefault(); void position.fillGap(gap.after); }}>{m.village_chat_continue()}</Link>
    {gapError === gap.after && <p role="status">{m.village_chat_history_retry()}</p>}
  </div>;
  return <main className="relative mx-auto max-w-3xl space-y-3 [overflow-anchor:none] [overflow-wrap:anywhere]">
    <VillageHeader village={loaderData.village} current="chat" chat={{ joined: true, unread: readThroughEnd ? 0 : unread }}>
      {hasTranslations && <button type="button" className="ui-meta underline" onClick={() => setOriginals(value => !value)}>{originals ? m.village_chat_translations() : m.village_chat_originals()}</button>}
    </VillageHeader>
    <ChatReaders village={loaderData.village} count={loaderData.readers} />
    {actionData && "error" in actionData && <p role="alert">{actionData.error === "duplicate" ? m.chat_reports_duplicate() : actionData.error === "unavailable" ? m.chat_reports_unavailable() : actionData.error === "invalid_reply" ? m.village_chat_reply_invalid() : actionData.error === "invalid" ? m.village_chat_invalid() : actionData.error === "limit" ? m.village_chat_limit() : m.village_chat_read_only()}</p>}
    {loaderData.targetUnavailable && <p role="status">{m.village_chat_reply_destination_unavailable()} <Link className="underline" to={`/v/${slug}/chat?latest=1#chat-bottom`}>{m.village_chat_latest()}</Link></p>}
    {loaderData.reported && <p role="status">{m.chat_reports_flagged()}</p>}
    {!interactive && report && <section role="dialog" aria-label={m.chat_reports_flag()} className="fixed inset-x-4 top-20 z-50 mx-auto max-h-[calc(100dvh-6rem)] max-w-xl overflow-auto rounded border bg-background p-3 shadow">
      <ChatReportForm id={report} /><Link className="underline ui-meta" to={`/v/${slug}/chat?at=${report}#chat-${report}`}>{m.cancel()}</Link>
    </section>}
    <Dialog open={interactive && report !== null} onOpenChange={open => {
      if (!open) { closeReport(); if (loaderData.report) navigate(`/v/${slug}/chat?at=${report}#chat-${report}`, { replace: true, preventScrollReset: true }); }
    }}>
      {interactive && report && <DialogContent showCloseButton={false} aria-label={m.chat_reports_flag()} finalFocus={reportLink} overlayClassName="bg-transparent supports-backdrop-filter:backdrop-blur-none" className="top-20 z-50 block max-h-[calc(100dvh-6rem)] w-[calc(100%-2rem)] max-w-xl -translate-y-0 overflow-auto rounded border bg-background p-3 shadow ring-0 sm:max-w-xl">
        <ChatReportForm key={report} id={report} /><Link className="underline ui-meta" to={`/v/${slug}/chat?at=${report}#chat-${report}`} onClick={event => { closeReport(); if (!loaderData.report) event.preventDefault(); }}>{m.cancel()}</Link>
      </DialogContent>}
    </Dialog>
    {reconnecting && <p role="status" className="ui-help text-muted-foreground">{m.village_chat_reconnecting()}</p>}
    {hasTranslations && <p className="ui-meta text-muted-foreground">{m.village_chat_translations_note()}</p>}
    {before !== null && <Link to={windowHref("before", before)} className="underline ui-meta" aria-disabled={loadingOlder} onClick={event => { event.preventDefault(); void position.history(); }}>{m.village_chat_previous()}</Link>}
    {historyError && <p role="status">{m.village_chat_history_retry()}</p>}
    <div ref={position.log} role="log" aria-label={m.village_chat_title()} className="space-y-2" onKeyDown={event => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches("[data-chat-message]")) return;
      const index = messages.findIndex(message => message.id === target.getAttribute("data-chat-message"));
      const next = event.key === "ArrowDown" ? Math.min(messages.length - 1, index + 1) : event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? messages.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); document.getElementById(`chat-${messages[next].id}`)?.focus();
    }}>
      {messages.map((message, i) => {
        const previous = messages[i - 1];
        const gap = gapsBySequence.get(message.createdSeq);
        const day = days.get(message.id)!;
        const previousDay = previous ? days.get(previous.id) : undefined;
        const newDay = !previous || previousDay !== day;
        return <div key={message.id}>
          {gap && renderGap(gap)}
          {newDay && <p role="separator" className="my-3 border-t pt-2 ui-meta text-muted-foreground">{chatDayLabel(message.createdAt, calendar, m.village_chat_today(), m.village_chat_yesterday(), day)}</p>}
          {boundary === message.createdSeq && <p id="chat-unread" className="my-3 flex scroll-mt-24 items-center gap-2 ui-meta font-medium" role="separator"><span aria-hidden="true" className="h-0.5 flex-1 bg-unread" />{m.village_chat_unread_start()}</p>}
          <ChatMessageView message={message} ended={ended} slug={slug} originals={originals} calendar={calendar} self={self} grouped={!gap && boundary !== message.createdSeq && groupChatMessage(previous, message, calendar, previousDay, day)} onReport={openReport} onReply={chooseReply} tabIndex={!interactive || focusedMessage === message.id ? 0 : -1} onActivate={activateMessage} />
        </div>;
      })}
      {gaps.filter(gap => gap.before === null).map(renderGap)}
      {!messages.length && !loaderData.targetUnavailable && <p>{m.village_chat_empty()}</p>}
    </div>
    {pending && <div data-chat-pending className="space-y-0.5 border-s-2 ps-2 text-muted-foreground">
      <p className="ui-meta">@{self}</p>
      <ChatReplyLine reply={pending.reply} slug={slug} createdAt={new Date().toISOString()} />
      <p dir="auto" className="whitespace-pre-wrap">{pending.body}</p>
      <p className="ui-meta" role="status">{m.village_chat_sending()}</p>
    </div>}
    {restored && <p className="ui-meta text-muted-foreground">{restored === "failed" ? m.village_chat_send_failed() : m.village_chat_send_unconfirmed()}</p>}
    {hasNewer && <Link to={windowHref("after", lastSeq)} className="block underline ui-meta" aria-disabled={loadingNewer} onClick={event => { event.preventDefault(); void position.continuation(); }}>{m.village_chat_continue()}</Link>}
    <div ref={position.bottom} id="chat-bottom" />
    {!!lastSeq && <noscript><Form method="post"><input type="hidden" name="seq" value={lastSeq} /><Button name="intent" value="read" type="submit" variant="outline">{m.village_chat_mark_read()}</Button></Form></noscript>}
    <div ref={composer} data-chat-composer className="sticky bottom-0 z-20 border-t bg-background py-2 [&_[role=listbox]]:top-auto [&_[role=listbox]]:bottom-full [&_[role=listbox]]:mt-0 [&_[role=listbox]]:mb-1" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
      {(!position.atBottom || hasNewer) && <Link to={`/v/${slug}/chat${windowHref("latest", 1)}#chat-bottom`} className="absolute bottom-full end-3 mb-2 inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1 ui-meta shadow-sm" onClick={event => { if (!hasNewer) { event.preventDefault(); position.latest(); } }}>{newMessageCount ? m.village_chat_new_messages({ count: newMessageCount >= 100 ? "99+" : String(newMessageCount) }) : m.village_chat_latest()}<ArrowDown aria-hidden="true" className="size-3.5" /></Link>}
      {!ended && replyTarget && <div data-chat-replying className="mb-2 flex min-w-0 items-center gap-2 ui-meta">
        <p className="min-w-0 flex-1 truncate">{deleted[replyTarget.id] || replyTarget.hidden ? m.village_chat_reply_unavailable() : m.village_chat_replying({ handle: replyTarget.author, text: chatReplyExcerpt(replyTarget.translation?.state === "ready" && replyTarget.translation.text !== null ? replyTarget.translation.text : replyTarget.parts.map(part => part.text).join("")) })}</p>
        <button type="button" className="shrink-0 underline" onClick={() => { setReply(null); sendForm.current?.querySelector("textarea")?.focus(); }}>{m.village_chat_reply_cancel()}</button>
      </div>}
      {ended ? <p role="status">{m.village_chat_read_only()}</p> : <Form ref={sendForm} method="post" preventScrollReset className="flex items-end gap-2" onSubmit={event => {
        if (sendingGuard.current) { event.preventDefault(); return; }
        noteSend(); sendingGuard.current = true; setSending(true);
        const field = event.currentTarget.querySelector("textarea");
        setRestored(null);
        pendingReply.current = reply;
        sentAfter.current = lastSeq;
        // Known from the press itself, so that a navigation that comes before the screen has drawn the submission is still seen as cutting it short.
        submission.current = { intent: "send", id: "" }; sendPhase.current = "submitting";
        if (field) {
          pendingBody.current = field.value;
          setPending({ body: field.value, reply: replyTarget ? chatReplyFromMessage(replyTarget) : null });
          // The form data is read right after this handler; the box is emptied once that is done.
          setTimeout(() => { field.value = ""; grow(field); setReply(null); }, 0);
        }
      }}>
        <input type="hidden" name="intent" value="send" />
        <input type="hidden" name="replyToId" value={reply?.id ?? ""} />
        <div className="min-w-0 flex-1"><label htmlFor="chat-send-body" className="sr-only">{m.village_chat_body()}</label><MentionTextarea id="chat-send-body" village={slug} name="body" required placeholder={m.village_chat_placeholder({ name: villageName(loaderData.village) })} maxLength={CHAT_BODY_MAX} rows={1} className="max-h-48 w-full resize-none rounded-md border p-2" onInput={event => grow(event.currentTarget)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && window.matchMedia("(min-width: 640px)").matches) { event.preventDefault(); sendForm.current?.requestSubmit(); }
        }} /></div>
        <Button type="submit" disabled={sending}>{m.village_chat_send()}</Button>
      </Form>}
    </div>
  </main>;
}

function ChatReaders({ village, count }: { village: { slug: string | null; language: string | null }; count: number }) {
  const label = m.village_chat_readers({ count });
  return <p className="ui-help">{village.language ? label : <Link className="link-ui" to={`/v/${village.slug}#village-roster`}>{label}</Link>}</p>;
}
