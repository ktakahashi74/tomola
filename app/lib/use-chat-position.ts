import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";
import type { ActiveChatMessage } from "./village-chat";
import { getChatReadingPosition, hasChatReadingPosition, rememberChatReadingPosition } from "./chat-reading-positions";

export function useChatPosition({ slug, messages, boundary, readSeq, readLimit, before, loadOlder, loadingOlder, loadNewer, loadingNewer, loadGap, hasNewer, seq, composerHeight, onRead }: {
  slug: string; messages: ActiveChatMessage[]; boundary: number | undefined; readSeq: number; readLimit: number; before: number | null;
  loadOlder: () => Promise<boolean>; loadingOlder: boolean; loadNewer: () => Promise<boolean>; loadingNewer: boolean; loadGap: (after: number) => Promise<boolean>; seq: number; hasNewer: boolean; composerHeight: number; onRead: (counts: { notifications: number; unreadCounts: Record<string, number> }) => void;
}) {
  const log = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null);
  const initialized = useRef(false), following = useRef(false);
  const [atBottom, setAtBottom] = useState(false), [newCount, setNewCount] = useState(0);
  const horizon = useRef(seq);
  const seen = useRef(new Set(messages.map(message => message.id)));
  const unseen = useRef(new Set<string>());
  const marked = useRef(readSeq);
  const [readFailed, setReadFailed] = useState(false);
  const lastScroll = useRef(0);
  const location = useLocation();
  const navigationType = useNavigationType();
  // Recognize a return even when this chat was the document's first history entry.
  const [restorePosition] = useState(() => navigationType === "POP" && (hasChatReadingPosition(`${slug}:${location.key}`)
    || typeof window !== "undefined" && (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "back_forward"));
  const restoredAnchor = useRef(restorePosition ? getChatReadingPosition(`${slug}:${location.key}`) : undefined);
  useLayoutEffect(() => () => {
    const first = [...(log.current?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? [])].find(element => element.getBoundingClientRect().top >= 90 && element.getBoundingClientRect().top < innerHeight - composerHeight);
    if (first) rememberChatReadingPosition(`${slug}:${location.key}`, { id: first.id, top: first.getBoundingClientRect().top, seq: Number(first.dataset.chatSeq) });
  }, [slug, location.key, composerHeight]);
  useEffect(() => { rememberChatReadingPosition(`${slug}:${location.key}`); }, [slug, location.key]);
  const latest = useCallback(() => {
    following.current = true; unseen.current.clear(); setNewCount(0); window.scrollTo(0, document.documentElement.scrollHeight);
  }, []);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      // Leave history traversal to ScrollRestoration. A fresh document still chooses its opening position.
      if (!restorePosition) {
        const at = new URLSearchParams(location.search).get("at");
        const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : at ? document.getElementById(`chat-${at}`) : null;
        const unread = boundary ? document.getElementById("chat-unread") : null;
        if (target) target.scrollIntoView({ block: "center" });
        else if (unread) unread.scrollIntoView({ block: "start" });
        else latest();
      }
      lastScroll.current = window.scrollY;
      initialized.current = true;
      following.current = !restoredAnchor.current && !hasNewer && (bottom.current?.getBoundingClientRect().bottom ?? Infinity) <= innerHeight - composerHeight + 32;
      setAtBottom(following.current);
    });
    return () => cancelAnimationFrame(frame);
  // Opening position is chosen once; later snapshots must preserve the reader's position.
  }, []);
  useLayoutEffect(() => {
    if (!initialized.current) return;
    const humanArrival = messages.some(message => !message.nushi && !seen.current.has(message.id) && message.createdSeq > horizon.current);
    if (following.current && !hasNewer && humanArrival) latest();
    const added = messages.filter(message => !seen.current.has(message.id) && message.createdSeq > horizon.current);
    if (!following.current) for (const message of added) if (!message.hidden && !message.nushi) unseen.current.add(message.id);
    const present = new Set(messages.filter(message => !message.hidden).map(message => message.id));
    for (const id of unseen.current) if (!present.has(id)) unseen.current.delete(id);
    setNewCount(unseen.current.size);
    for (const message of messages) seen.current.add(message.id);
  }, [messages, composerHeight, hasNewer, latest, before]);
  const history = useCallback(async () => {
    if (loadingOlder || before === null) return;
    following.current = false;
    await loadOlder();
  }, [before, loadingOlder, loadOlder]);
  useLayoutEffect(() => {
    const saved = restoredAnchor.current;
    if (!saved) return;
    following.current = false;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(saved.id);
      if (target) { window.scrollBy(0, target.getBoundingClientRect().top - saved.top); restoredAnchor.current = undefined; }
      else if ((messages[0]?.createdSeq ?? 0) > saved.seq && before !== null && !loadingOlder) void loadOlder();
      else if (!loadingOlder) restoredAnchor.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, before, loadingOlder, loadOlder]);
  const continuation = useCallback(async () => {
    if (loadingNewer || !hasNewer) return;
    following.current = false;
    await loadNewer();
  }, [loadingNewer, hasNewer, loadNewer]);
  const fillGap = useCallback((after: number) => {
    following.current = false; setAtBottom(false);
    return loadGap(after);
  }, [loadGap]);
  const lastLocation = useRef(location.key);
  useLayoutEffect(() => {
    if (!initialized.current || lastLocation.current === location.key) return;
    if (navigationType === "POP") { lastLocation.current = location.key; return; }
    const search = new URLSearchParams(location.search);
    const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : search.has("at") ? document.getElementById(`chat-${search.get("at")}`) : null;
    if (search.has("latest")) latest();
    else if (target) target.scrollIntoView({ block: "center" });
    else return;
    lastLocation.current = location.key;
  }, [location, navigationType, messages, latest]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!initialized.current) return;
        const viewport = window.visualViewport;
        const visibleBottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
        const atEnd = !hasNewer && (bottom.current?.getBoundingClientRect().bottom ?? Infinity) <= visibleBottom - composerHeight + 32;
        following.current = atEnd; setAtBottom(atEnd);
        if (atEnd) { unseen.current.clear(); setNewCount(0); }
        const movingUp = window.scrollY < lastScroll.current;
        const movingDown = window.scrollY > lastScroll.current;
        lastScroll.current = window.scrollY;
        if (movingDown && hasNewer && !loadingNewer && (bottom.current?.getBoundingClientRect().top ?? Infinity) < visibleBottom - composerHeight + 160) void continuation();
        if (movingUp && window.scrollY < 160 && before !== null && !loadingOlder) void history();
      });
    };
    // Layout and composer changes are not a request to advance a historical window.
    lastScroll.current = window.scrollY;
    update();
    window.addEventListener("scroll", update, { passive: true }); window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [before, loadingOlder, history, composerHeight, hasNewer, loadingNewer, continuation]);
  const readContext = useRef({ readLimit, onRead });
  const syncReadTargets = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    readContext.current = { readLimit, onRead };
    syncReadTargets.current?.();
  }, [messages, readLimit, onRead]);
  useEffect(() => {
    if (!log.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined, pending = marked.current, busy = false, disposed = false;
    const controller = new AbortController();
    const submit = async () => {
      if (busy || pending <= marked.current || pending > readContext.current.readLimit || document.hidden) return;
      busy = true; const seq = pending;
      try {
        const response = await fetch(`/v/${slug}/chat/read`, { redirect: "error", method: "POST", signal: controller.signal, body: new URLSearchParams({ intent: "read", seq: String(seq), background: "1" }) });
        if (disposed) return;
        setReadFailed(!response.ok);
        if (response.ok) {
          marked.current = Math.max(marked.current, seq);
          const unreadCounts = JSON.parse(response.headers.get("X-Chat-Unread-Counts") ?? "{}");
          readContext.current.onRead({ notifications: Number(response.headers.get("X-Unread-Notifications") ?? "0"), unreadCounts });
        }
      } catch { if (!disposed) setReadFailed(true); }
      finally { busy = false; if (!disposed && pending > seq) queue(); }
    };
    const viewport = window.visualViewport;
    let observer: IntersectionObserver | undefined, margin = "";
    const targets = new Set<Element>();
    const consider = (target: Element, rect: DOMRectReadOnly, intersects: boolean) => {
      if (!initialized.current || document.hidden) return;
      const top = Math.max(90, viewport?.offsetTop ?? 0, document.querySelector("[data-village-header]")?.getBoundingClientRect().bottom ?? 0);
      const bottom = (viewport ? viewport.offsetTop + viewport.height : innerHeight) - composerHeight;
      const seq = Number((target as HTMLElement).dataset.chatReadSeq);
      if (seq <= readContext.current.readLimit && intersects && rect.top >= top && rect.bottom <= bottom) pending = Math.max(pending, seq);
    };
    const queue = () => { clearTimeout(timer); timer = setTimeout(() => void submit(), 150); };
    const sync = () => {
      const elements = new Set(log.current?.querySelectorAll("[data-chat-read-seq]") ?? []);
      for (const element of targets) if (!elements.has(element)) { observer?.unobserve(element); targets.delete(element); }
      for (const element of elements) {
        if (!targets.has(element)) { observer?.observe(element); targets.add(element); }
        // Newly completed coverage can admit an already-visible marker without
        // rebuilding the observer or waiting for an intersection transition.
        consider(element, element.getBoundingClientRect(), true);
      }
      queue();
    };
    const observe = () => {
      const visibleBottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
      const nextMargin = `-90px 0px -${composerHeight + Math.max(0, innerHeight - visibleBottom)}px 0px`;
      if (!observer || nextMargin !== margin) {
        observer?.disconnect(); targets.clear(); margin = nextMargin;
        observer = new IntersectionObserver(entries => {
          for (const entry of entries) consider(entry.target, entry.boundingClientRect, entry.isIntersecting);
          queue();
        }, { rootMargin: margin });
      }
      sync();
    };
    syncReadTargets.current = sync;
    observe();
    viewport?.addEventListener("resize", observe); viewport?.addEventListener("scroll", observe);
    const visible = () => { if (!document.hidden) { sync(); void submit(); } };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true; controller.abort(); syncReadTargets.current = null;
      clearTimeout(timer); observer?.disconnect();
      viewport?.removeEventListener("resize", observe); viewport?.removeEventListener("scroll", observe); document.removeEventListener("visibilitychange", visible);
    };
  }, [slug, composerHeight]);
  return { log, bottom, atBottom, newCount, latest, history, continuation, fillGap, readFailed };
}
