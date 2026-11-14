import { ChatTranslationReport } from "~/components/chat-translation-report";
import { ChatReplyLine } from "~/components/chat-reply";
import { memo, useEffect, useRef, useState } from "react";
import { Form, Link, useRouteLoaderData } from "react-router";
import { CHAT_BODY_MAX, chatParts, type ActiveChatMessage } from "~/lib/village-chat";
import { MentionTextarea } from "~/components/mention-autocomplete";
import { Button } from "~/components/ui/button";
import { ChatTopicCards } from "~/components/chat-topic-cards";
import { NEAR_COPY_FLAGS } from "~/lib/llm/flags";
import { m } from "~/paraglide/messages.js";
import { chatClock, type ChatCalendar } from "~/lib/chat-calendar";
import { useTranslationWait, waitText } from "~/lib/translation-wait";
import { NushiPending } from "~/components/nushi-pending";

export const ChatMessageView = memo(function ChatMessageView({ message, ended, slug, originals, grouped, calendar, self, onReport, onReply, tabIndex = 0, onActivate }: {
  message: ActiveChatMessage; ended: boolean; slug: string; originals: boolean; grouped: boolean; calendar: ChatCalendar; self: string; onReport: (id: string) => void; onReply?: (message: ActiveChatMessage) => void; tabIndex?: number; onActivate?: (id: string) => void;
}) {
  const [actionsShown, setActionsShown] = useState(false);
  const [selection, setSelection] = useState<{ basis: boolean; override: boolean | null }>({ basis: originals, override: null });
  if (selection.basis !== originals) setSelection({ basis: originals, override: null });
  const original = (selection.basis === originals ? selection.override : null) ?? originals;
  const interactionTabIndex = tabIndex === 0 ? undefined : -1;
  const clock = chatClock(message.createdAt, calendar);
  const [waiting, setWaiting] = useState(false);
  // When the chat translation budget is the reason, the notice does not wait for the usual short delay: it is not a matter of a moment.
  const wait = useTranslationWait("chat");
  useEffect(() => {
    if (message.translation?.state !== "pending") { setWaiting(false); return; }
    const timer = setTimeout(() => setWaiting(true), Math.max(0, new Date(message.createdAt).getTime() + 2500 - Date.now()));
    return () => clearTimeout(timer);
  }, [message.createdAt, message.translation?.state]);
  const translated = !original && message.translation?.state === "ready" && message.translation.text !== null;
  const parts = translated ? chatParts(message.translation!.text!, new Map(message.parts.filter(part => part.type === "mention").map(part => [part.text, { prefix: part.text.slice(1), href: part.href }]))) : message.parts;
  // A message that names the member: a pale ground and a thin band (the amber of "new for you").
  const mentionsMe = !message.own && message.parts.some(part => part.type === "mention" && part.text.toLowerCase() === `@${self}`.toLowerCase());
  // A message that is only the address of a post shows the post's card alone.
  const onlyPostCard = !!message.topics?.length && parts.every(part => part.type === "link" || part.type === "text" && !part.text.trim());
  const cancel = (element: HTMLElement) => { const details = element.closest("details"); if (details) { details.querySelector("form")?.reset(); details.open = false; } };
  return <article id={`chat-${message.id}`} data-chat-message={message.id} data-chat-seq={message.createdSeq} data-chat-nushi={message.nushi ? "1" : undefined} aria-live={message.nushi ? "polite" : undefined} lang={translated ? message.translation!.lang : message.lang} tabIndex={tabIndex} onFocus={() => onActivate?.(message.id)} aria-labelledby={`chat-byline-${message.id}`} data-mentions-me={mentionsMe || undefined} className={`group/chat relative scroll-mt-28 py-1 outline-offset-2 ${grouped ? "" : "grid grid-cols-1"} ${mentionsMe ? "border-s-2 border-unread bg-unread/10 ps-2" : ""}`} onClick={() => setActionsShown(true)} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setActionsShown(false);
  }}>
    <p id={`chat-byline-${message.id}`} className={grouped ? "sr-only" : "flex flex-wrap items-baseline gap-2 ui-meta text-muted-foreground"}>
      {!grouped && message.avatarUrl && <img src={message.avatarUrl} alt="" className="member-avatar self-center rounded" />}
      <span className="min-w-0 truncate" title={`@${message.author}`}>{message.nushi ? <>{m.nushi_name()} · {m.chat_nushi_label({ handle: message.nushi.caller ?? "?" })}</> : <>{message.authorName && <><bdi>{message.authorName}</bdi>{" "}</>}@{message.author}</>}</span><time className="shrink-0 whitespace-nowrap" dateTime={message.createdAt} title={clock.full}>{clock.time}</time>
      {message.edited && <span>{m.village_chat_edited()}</span>}
      {!grouped && translated && <TranslationMark tabIndex={interactionTabIndex} />}
    </p>
    {message.hidden ? <p>{message.nushi ? m.nushi_hidden() : m.village_chat_hidden()}</p> : <>
      <ChatReplyLine reply={message.reply} slug={slug} createdAt={message.createdAt} tabIndex={interactionTabIndex} />
      {grouped && translated && <span className="float-end"><TranslationMark tabIndex={interactionTabIndex} /></span>}
      {message.nushi?.departed?.map(handle => <p key={handle} className="ui-help">@{handle} · {m.nushi_left()}</p>)}
      {message.nushi?.edited && <p className="ui-help">{m.chat_nushi_call_edited()}</p>}
      {!onlyPostCard && (message.nushi ? <ChatNushiBody parts={parts} /> : <p dir="auto" className="whitespace-pre-wrap">{parts.map((part, i) => part.type === "text" ? part.text : <a key={i} tabIndex={interactionTabIndex} href={part.href} className={part.type === "mention" ? "mention" : "underline"} rel="nofollow noopener noreferrer">{part.text}</a>)}</p>)}
      {message.translation?.state === "pending" && (waiting || wait.kind !== "normal") && <p className="mt-1 ui-help text-muted-foreground">{wait.kind === "normal" ? m.village_chat_translation_pending() : waitText(wait, false)}</p>}
      {message.translation?.state === "failed" && !NEAR_COPY_FLAGS.includes(message.translation.errorCode ?? "") && <p className="mt-1 ui-help text-muted-foreground">{m.village_chat_translation_failed()}</p>}
      {message.translation?.state === "paused" && <p className="mt-1 ui-help text-muted-foreground">{waitText({ kind: "stopped" }, false)}</p>}
    </>}
    {message.nushiCall && message.nushiCall.state !== "answered" && <p role="status" data-nushi-status className="ui-help text-muted-foreground">{["pending", "processing"].includes(message.nushiCall.state) ? <NushiPending /> : <>{m.nushi_failed()} {message.nushiCall.failure === "limit" ? m.nushi_failure_limit() : message.nushiCall.failure === "budget" ? m.nushi_failure_budget() : message.nushiCall.failure === "expired" ? m.nushi_failure_expired() : ""}</>}</p>}
    {!message.hidden && <ChatTopicCards topics={message.topics} tabIndex={interactionTabIndex} />}
    {/* Anchor overlays below the visible byline and reply link, without moving later messages. */}
    <div data-chat-actions data-shown={actionsShown} className={`pointer-events-none absolute end-0 z-10 flex max-w-full flex-nowrap items-start gap-x-3 gap-y-1 rounded bg-background ui-meta opacity-0 ${grouped ? "-top-4" : message.reply && !message.hidden ? "top-0 row-start-3" : "top-0 row-start-2"}
      focus-within:pointer-events-auto focus-within:opacity-100 sm:group-hover/chat:pointer-events-auto sm:group-hover/chat:opacity-100
      max-sm:flex-wrap pointer-coarse:flex-wrap data-[shown=true]:pointer-events-auto data-[shown=true]:opacity-100 max-sm:data-[shown=true]:static max-sm:data-[shown=true]:row-auto max-sm:data-[shown=true]:mt-1 pointer-coarse:data-[shown=true]:static pointer-coarse:data-[shown=true]:row-auto pointer-coarse:data-[shown=true]:mt-1
      has-[details[open]]:pointer-events-auto has-[details[open]]:static has-[details[open]]:row-auto has-[details[open]]:mt-1 has-[details[open]]:flex-wrap has-[details[open]]:opacity-100`}>
      {!ended && !message.hidden && onReply && <button tabIndex={interactionTabIndex} type="button" className="underline" onClick={() => onReply(message)}>{m.village_chat_reply()}</button>}
      {!message.hidden && message.translation?.state === "ready" && <button tabIndex={interactionTabIndex} type="button" className="underline" onClick={() => setSelection({ basis: originals, override: !original })}>{original ? m.village_chat_translation_show() : m.village_chat_translation_original()}</button>}
      {!message.own && !message.hidden && translated && <ChatTranslationReport key={message.translation!.text} id={message.id} lang={message.translation!.lang} tabIndex={interactionTabIndex} />}
      {!message.own && !message.hidden && <Link tabIndex={interactionTabIndex} className="underline" to={`/v/${slug}/chat?report=${message.id}`} onClick={event => { event.preventDefault(); onReport(message.id); }}>{m.chat_reports_flag()}</Link>}
      {message.own && <>
        {!ended && !message.hidden && <details className="min-w-0 open:w-64 sm:open:w-96"><summary tabIndex={interactionTabIndex} className="cursor-pointer underline">{m.village_chat_edit()}</summary><Form method="post" preventScrollReset className="mt-2 space-y-2">
          <input type="hidden" name="intent" value="edit" /><input type="hidden" name="id" value={message.id} />
          <label htmlFor={`chat-edit-${message.id}`} className="sr-only">{m.village_chat_edit()}</label><MentionTextarea tabIndex={interactionTabIndex} id={`chat-edit-${message.id}`} village={slug} name="body" required maxLength={CHAT_BODY_MAX} className="w-full rounded-md border p-2" defaultValue={message.parts.map(part => part.text).join("")} onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); cancel(event.currentTarget); }
            else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && window.matchMedia("(min-width: 640px)").matches) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} />
          <div className="flex gap-2"><Button tabIndex={interactionTabIndex} type="submit" size="sm">{m.save_changes()}</Button><Link tabIndex={interactionTabIndex} to={`/v/${slug}/chat?at=${message.id}#chat-${message.id}`} className="underline" onClick={event => { event.preventDefault(); cancel(event.currentTarget); }}>{m.cancel()}</Link></div>
        </Form></details>}
        <details><summary tabIndex={interactionTabIndex} className="cursor-pointer underline">{m.village_chat_delete()}</summary><Form method="post" preventScrollReset className="mt-2 flex gap-2">
          <input type="hidden" name="id" value={message.id} /><Button tabIndex={interactionTabIndex} name="intent" value="delete" type="submit" variant="outline" size="sm">{m.delete_confirm()}</Button><Link tabIndex={interactionTabIndex} to={`/v/${slug}/chat?at=${message.id}#chat-${message.id}`} className="underline" onClick={event => { event.preventDefault(); cancel(event.currentTarget); }}>{m.cancel()}</Link>
        </Form></details>
      </>}
    </div>
    {!message.own && <span data-chat-read-seq={message.nushi ? undefined : message.createdSeq} className="block h-px" aria-hidden="true" />}
  </article>;
});

// The small mark of a message shown by its machine translation. "Unverified machine translation" stays as its name (read out, and on hover); the page says it once in words.
function TranslationMark({ tabIndex }: { tabIndex?: number }) {
  return <a href="/ai-use" tabIndex={tabIndex} title={m.village_chat_translation_machine()} className="shrink-0 rounded border px-1 text-[0.7rem] leading-4"><span aria-hidden="true">{m.village_chat_translation_badge()}</span><span className="sr-only">{m.village_chat_translation_machine()}</span></a>;
}

export function ChatNushiBody({ parts }: { parts: ActiveChatMessage["parts"] }) {
  const root = useRouteLoaderData("root") as { siteOrigin?: string | null } | undefined;
  const ref = useRef<HTMLParagraphElement>(null), [long, setLong] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => { if (element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 8 + 1) setLong(true); };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [parts]);
  const body = <p ref={ref} dir="auto" className="whitespace-pre-wrap">{parts.map((part, i) => {
    if (part.type === "text") return part.text;
    let source = false;
    try {
      const url = new URL(part.href);
      source = part.type === "link" && url.origin === root?.siteOrigin && /^\/t\/\d+$/.test(url.pathname)
        && (i === 0 || parts[i - 1].text.endsWith("\n"))
        && (i === parts.length - 1 || parts[i + 1].text.startsWith("\n"));
    }
    catch { /* Preserve the existing label for an unrecognized destination. */ }
    return <a key={i} href={part.href} className="underline" rel="nofollow noopener noreferrer">{source ? m.nushi_open_post() : part.text}</a>;
  })}</p>;
  return long ? <details className="space-y-2"><summary className="cursor-pointer underline">{m.chat_nushi_read()}</summary>{body}</details> : body;
}
