import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";
import { emptyChatWindow, mergeChatMessages, mergeChatUnreadCounts } from "./chat-message-window";
import type { ChatMessage } from "./village-chat";
import { addChatReadRange, chatForwardRange, chatReadGaps, chatReadThrough, chatSnapshotRange } from "./chat-read-coverage";

type Snapshot = { messages: ChatMessage[]; seq: number; readSeq: number; readFrom: number | null; ended: boolean; historical: boolean; hasNewer: boolean; before: number | null; unreadAfter: number; window: string; latest: boolean; unreadCounts: Record<string, number> };
export function useVillageChat(slug: string, initial: Snapshot, langParam: string | null = null) {
  const [messageWindow, setMessageWindow] = useState(() => mergeChatMessages(emptyChatWindow(), initial.messages));
  const messages = messageWindow.messages;
  const messagesRef = useRef(messages);
  const readingAnchor = useRef<{ id: string; top: number } | null>(null);
  // This hook runs before useChatPosition: restore the viewport before its
  // layout effect admits visible markers to the read receipt queue.
  useLayoutEffect(() => {
    messagesRef.current = messages;
    const anchor = readingAnchor.current;
    readingAnchor.current = null;
    if (anchor) {
      const target = document.getElementById(anchor.id);
      if (target) window.scrollBy(0, target.getBoundingClientRect().top - anchor.top);
    }
  }, [messageWindow]);
  const mergeMessages = useCallback((incoming: ChatMessage[], options: Parameters<typeof mergeChatMessages>[2] = {}, replace = false) => {
    const anchor = [...document.querySelectorAll<HTMLElement>("[data-chat-message]")].find(element => element.getBoundingClientRect().bottom > 100);
    const anchorSeq = anchor ? Number(anchor.dataset.chatSeq) : undefined;
    readingAnchor.current = !replace && anchor ? { id: anchor.id, top: anchor.getBoundingClientRect().top } : null;
    setMessageWindow(old => mergeChatMessages(replace ? emptyChatWindow() : old, incoming, { anchor: anchorSeq, ...options }));
  }, []);
  const [readRanges, setReadRanges] = useState(() => addChatReadRange([], chatSnapshotRange(initial)));
  const liveReadFrom = useRef(initial.seq);
  const pollVersion = useRef(0);
  const [unreadCounts, setUnreadCounts] = useState(initial.unreadCounts);
  const updateUnreadCounts = useCallback((counts: Record<string, number>) => setUnreadCounts(old => mergeChatUnreadCounts(old, counts, true)), []);
  const requestPoll = useRef<() => void>(() => {});
  const refresh = useCallback(() => requestPoll.current(), []);
  const [unreadAfter, setUnreadAfter] = useState(initial.unreadAfter);
  const lastCounts = useRef(Date.now());
  const windowKey = useRef(initial.window);
  const location = useLocation(), navigation = useNavigation();
  const entry = useRef(location.key), sending = useRef(false);
  const noteSend = useCallback(() => { sending.current = true; }, []);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const newerBusy = useRef(false);
  const newerController = useRef<AbortController | null>(null);
  const [loadingGap, setLoadingGap] = useState<number | null>(null);
  const [gapError, setGapError] = useState<number | null>(null);
  const gapBusy = useRef(false), gapController = useRef<AbortController | null>(null);
  const [sourceBefore, setBefore] = useState(initial.before);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const olderBusy = useRef(false);
  const olderController = useRef<AbortController | null>(null);
  const [ended, setEnded] = useState(initial.ended);
  const cursor = useRef(initial.seq);
  const historical = useRef(initial.historical);
  const lastVisible = useRef(initial.messages.at(-1)?.createdSeq ?? 0);
  const [sourceHasNewer, setHasNewer] = useState(initial.hasNewer);
  const before = messageWindow.olderCut !== null ? messages[0]?.createdSeq ?? messageWindow.olderCut + 1 : sourceBefore;
  const hasNewer = sourceHasNewer || messageWindow.newerCut !== null;
  const [reconnecting, setReconnecting] = useState(false);
  useLayoutEffect(() => {
    const end = messages.at(-1)?.createdSeq ?? 0;
    if (messageWindow.newerCut !== null) {
      lastVisible.current = end;
      if (!historical.current) { historical.current = true; pollVersion.current++; requestPoll.current(); }
    }
    else lastVisible.current = Math.max(lastVisible.current, end);
  }, [messageWindow]);
  useEffect(() => {
    // A send keeps the reader's loaded history; an explicit window jump replaces it.
    const sent = sending.current;
    const changedWindow = (windowKey.current !== initial.window || entry.current !== location.key && initial.latest) && !sent;
    entry.current = location.key; sending.current = false;
    windowKey.current = initial.window;
    const end = initial.messages.at(-1)?.createdSeq ?? 0;
    const gap = sent && (initial.messages[0]?.createdSeq ?? 0) > lastVisible.current + 1;
    if (changedWindow) pollVersion.current++;
    if (changedWindow || initial.latest || end >= lastVisible.current) {
      if (historical.current !== initial.historical) pollVersion.current++;
      historical.current = initial.historical;
      setHasNewer(initial.hasNewer); setUnreadAfter(initial.unreadAfter);
    }
    lastVisible.current = changedWindow ? end : Math.max(lastVisible.current, end);
    if (changedWindow) { cursor.current = initial.seq; liveReadFrom.current = initial.seq; }
    setReadRanges(old => addChatReadRange(changedWindow ? [] : old, chatSnapshotRange(initial)));
    if (changedWindow || gap) setBefore(initial.before);
    setUnreadCounts(old => mergeChatUnreadCounts(old, initial.unreadCounts, true));
    mergeMessages(initial.messages, { ...(sent ? { edge: "newer" as const } : {}) }, changedWindow);
    setEnded(initial.ended);
  }, [initial]);
  useEffect(() => { if (navigation.state === "idle") sending.current = false; }, [navigation.state]);
  useEffect(() => () => { olderController.current?.abort(); newerController.current?.abort(); gapController.current?.abort(); }, []);
  const loadGap = useCallback(async (after: number) => {
    if (gapBusy.current) return false;
    gapBusy.current = true; setLoadingGap(after); setGapError(null); setHistoryError(false);
    const controller = new AbortController(); gapController.current = controller;
    const since = cursor.current, version = pollVersion.current;
    try {
      const response = await fetch(`/v/${slug}/chat/changes?since=${since}&forward=${after}${langParam ? `&lang=${encodeURIComponent(langParam)}` : ""}`, { cache: "no-store", signal: controller.signal });
      if ([401, 404].includes(response.status)) { window.location.replace(`/v/${slug}`); return false; }
      if (!response.ok) throw new Error("History unavailable");
      const page = await response.json() as { messages: ChatMessage[]; hasNewer: boolean; unread: number };
      if (controller.signal.aborted || version !== pollVersion.current) return false;
      // Filling an internal interval leaves the live frontier and its polling cursor intact.
      setReadRanges(old => addChatReadRange(old, chatForwardRange(after, since, page)));
      setUnreadCounts(old => mergeChatUnreadCounts(old, { [slug]: page.unread }));
      mergeMessages(page.messages, {});
      return page.messages.length > 0;
    } catch { if (!controller.signal.aborted && version === pollVersion.current) setGapError(after); return false; }
    finally { gapBusy.current = false; if (!controller.signal.aborted) setLoadingGap(null); }
  }, [slug, langParam]);
  const loadNewer = useCallback(async () => {
    if (!hasNewer || newerBusy.current) return false;
    newerBusy.current = true; setLoadingNewer(true); setHistoryError(false);
    const controller = new AbortController(); newerController.current = controller;
    const after = lastVisible.current, since = cursor.current, version = pollVersion.current;
    try {
      const response = await fetch(`/v/${slug}/chat/changes?since=${since}&forward=${after}${langParam ? `&lang=${encodeURIComponent(langParam)}` : ""}`, { cache: "no-store", signal: controller.signal });
      if ([401, 404].includes(response.status)) { window.location.replace(`/v/${slug}`); return false; }
      if (!response.ok) throw new Error("History unavailable");
      const page = await response.json() as { messages: ChatMessage[]; hasNewer: boolean; unreadAfter: number; unread: number };
      if (controller.signal.aborted || version !== pollVersion.current) return false;
      setReadRanges(old => addChatReadRange(old, chatForwardRange(after, since, page)));
      lastVisible.current = Math.max(lastVisible.current, page.messages.at(-1)?.createdSeq ?? 0);
      historical.current = page.hasNewer; setHasNewer(page.hasNewer); setUnreadAfter(page.unreadAfter);
      setUnreadCounts(old => mergeChatUnreadCounts(old, { [slug]: page.unread }));
      mergeMessages(page.messages, { edge: "newer" });
      if (!page.hasNewer) {
        // Historical polls skipped unknown rows: replay from this page's requested checkpoint.
        pollVersion.current++; cursor.current = since; liveReadFrom.current = since;
        requestPoll.current();
      }
      return page.messages.length > 0;
    } catch { if (!controller.signal.aborted) setHistoryError(true); return false; }
    finally { newerBusy.current = false; if (!controller.signal.aborted) setLoadingNewer(false); }
  }, [hasNewer, slug, langParam]);
  const loadOlder = useCallback(async () => {
    if (before === null || olderBusy.current) return false;
    olderBusy.current = true; setLoadingOlder(true); setHistoryError(false);
    const controller = new AbortController(); olderController.current = controller;
    const version = pollVersion.current;
    try {
      const response = await fetch(`/v/${slug}/chat/changes?since=${cursor.current}&before=${before}${langParam ? `&lang=${encodeURIComponent(langParam)}` : ""}`, { cache: "no-store", signal: controller.signal });
      if ([401, 404].includes(response.status)) { window.location.replace(`/v/${slug}`); return false; }
      if (!response.ok) throw new Error("History unavailable");
      const page = await response.json() as { messages: ChatMessage[]; before: number | null };
      if (controller.signal.aborted || version !== pollVersion.current) return false;
      setReadRanges(old => addChatReadRange(old, { from: page.before === null ? 0 : page.messages[0]?.createdSeq ?? before, to: before - 1 }));
      mergeMessages(page.messages, { edge: "older" });
      setBefore(page.before);
      return page.messages.length > 0;
    } catch { if (!controller.signal.aborted) setHistoryError(true); return false; }
    finally { olderBusy.current = false; if (!controller.signal.aborted) setLoadingOlder(false); }
  }, [before, slug, langParam]);
  useEffect(() => {
    let disposed = false, connected = false, busy = false, requested = false, attempts = 0, failures = 0;
    const failed = () => { if (++failures >= 2) setReconnecting(true); };
    let source: EventSource | undefined, retry: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let scheduled: ReturnType<typeof setTimeout> | undefined, limitedUntil = 0;
    const schedule = (delay = Math.floor(Math.random() * 501)) => {
      if (disposed || scheduled) return;
      scheduled = setTimeout(() => { scheduled = undefined; void poll(); }, Math.max(delay, limitedUntil - Date.now()));
    };
    const invalidate = () => {
      disposed = true; source?.close(); clearTimeout(retry); controller?.abort();
      setMessageWindow(emptyChatWindow()); window.location.replace(`/v/${slug}`);
    };
    const poll = async () => {
      if (disposed || document.hidden) return;
      if (Date.now() < limitedUntil) { schedule(); return; }
      if (busy) { requested = true; return; }
      busy = true; controller = new AbortController();
      try {
        let more = true;
        while (more && !disposed && !document.hidden) {
          const end = lastVisible.current, windowed = historical.current, version = pollVersion.current;
          const counts = Date.now() - lastCounts.current >= 30_000;
          const response = await fetch(`/v/${slug}/chat/changes?since=${cursor.current}${windowed ? `&after=${end}` : ""}${counts ? "&counts=1" : ""}${langParam ? `&lang=${encodeURIComponent(langParam)}` : ""}`, { cache: "no-store", signal: controller.signal });
          if ([401, 404].includes(response.status)) { invalidate(); return; }
          if (response.status === 429) {
            const retryAfter = response.headers.get("Retry-After");
            const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 1;
            limitedUntil = Date.now() + seconds * 1000 + Math.floor(Math.random() * 501);
            schedule(); return;
          }
          if (!response.ok) { failed(); return; }
          const change = await response.json() as { messages: ChatMessage[]; next: number; more: boolean; ended: boolean; hasNewer?: boolean; unread: number; unreadAfter: number; unreadCounts?: Record<string, number> };
          if (disposed || document.hidden) return;
          failures = 0; setReconnecting(false);
          if (version !== pollVersion.current) { requested = true; return; }
          cursor.current = change.next; setEnded(change.ended);
          if (windowed) liveReadFrom.current = change.next;
          else if (!change.more) {
            const from = liveReadFrom.current + 1;
            setReadRanges(old => addChatReadRange(old, { from, to: change.next }));
            liveReadFrom.current = change.next;
          }
          if (counts) lastCounts.current = Date.now();
          setUnreadCounts(old => mergeChatUnreadCounts(old, { ...change.unreadCounts, [slug]: change.unread }));
          if (end === lastVisible.current) {
            setUnreadAfter(change.unreadAfter);
            if (windowed && typeof change.hasNewer === "boolean") setHasNewer(change.hasNewer);
          }
          if (!windowed) lastVisible.current = Math.max(lastVisible.current, ...change.messages.map(message => message.createdSeq));
          mergeMessages(change.messages, { onlyExisting: windowed, minimumSeq: messagesRef.current[0]?.createdSeq });
          more = change.more;
        }
      } catch { if (!disposed && !controller?.signal.aborted) failed(); }
      finally { busy = false; if (requested) { requested = false; schedule(); } }
    };
    requestPoll.current = () => { void poll(); };
    const connect = () => {
      if (disposed || document.hidden || source) return;
      source = new EventSource(`/v/${slug}/chat/events`);
      source.onopen = () => { connected = true; attempts = 0; schedule(); };
      source.addEventListener("change", event => { if (Number((event as MessageEvent).data) > cursor.current) schedule(); });
      source.onerror = () => {
        source?.close(); source = undefined; connected = false;
        void poll();
        retry = setTimeout(connect, Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6)) * (0.8 + Math.random() * 0.4));
      };
    };
    const visible = () => {
      if (document.hidden) { source?.close(); source = undefined; connected = false; clearTimeout(retry); controller?.abort(); }
      else { void poll(); connect(); }
    };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) { source?.close(); source = undefined; connected = false; clearTimeout(retry); visible(); } };
    // One clock covers both fallback polling and the connected safety check.
    let ticks = 0;
    const timer = setInterval(() => { if (!connected || ++ticks % 4 === 0) void poll(); }, 15_000);
    document.addEventListener("visibilitychange", visible); window.addEventListener("pageshow", restored);
    visible();
    return () => {
      disposed = true; requestPoll.current = () => {}; source?.close(); controller?.abort(); clearTimeout(retry); clearTimeout(scheduled); clearInterval(timer);
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("pageshow", restored);
    };
  }, [slug, langParam]);
  const visibleMessages = messages;
  const readLimit = chatReadThrough(initial.readSeq, readRanges);
  const gaps = useMemo(() => chatReadGaps(visibleMessages, readRanges), [visibleMessages, readRanges]);
  return { noteSend, reconnecting, messages: visibleMessages, deleted: messageWindow.deleted, readLimit, gaps, loadGap, loadingGap, gapError, ended, hasNewer, before, loadOlder, loadingOlder, historyError, unreadAfter, loadNewer, loadingNewer, unreadCounts, updateUnreadCounts, refresh };
}
