import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { appendReadingItems, readingHref, readingLatestHref, READING_BATCH, READING_CHUNK_PARAM, READING_RESTORE_MAX, type ReadingChunk, type ReadingPage } from "~/lib/reading-page";
import { readingVisitKey, useReadingPosition } from "~/lib/use-reading-position";
import { buttonVariants } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

// Serialize address changes when two sections finish appending together.
let addressUpdate = Promise.resolve();

type ListProps<T> = ReadingChunk<T> & {
  anchor?: string;
  companion?: ReadingPage;
  children: (topics: T[]) => ReactNode;
};

export function ReadingList<T extends { id: number }>(props: ListProps<T>) {
  const location = useLocation();
  return <ReadingListView key={readingVisitKey(location)} {...props} />;
}

function ReadingListView<T extends { id: number }>({ topics, list, anchor = "", companion, children }: ListProps<T>) {
  const location = useLocation();
  const navigate = useNavigate();
  useReadingPosition();
  const container = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const live = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const [view, setView] = useState({ source: topics, topics, list, announcement: "", failed: false, pending: false, focusId: null as number | null });
  if (view.source !== topics) {
    setView({ source: topics, topics, list, announcement: "", failed: false, pending: false, focusId: null });
  }
  useLayoutEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [topics]);
  useLayoutEffect(() => {
    // When the last control disappears, focus the first appended row.
    if (view.focusId !== null) container.current?.querySelector<HTMLAnchorElement>(`#q-${view.focusId} a, [data-reading-id="${view.focusId}"] a`)?.focus({ preventScroll: true });
  }, [view.focusId]);

  const next = `${location.pathname}${readingHref(location.search, view.list, true, companion)}`;
  const atLimit = view.topics.length + READING_BATCH > READING_RESTORE_MAX;

  async function loadMore() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setView({ ...view, pending: true, announcement: "", failed: false });
    try {
      const url = new URL(next, window.location.origin);
      url.searchParams.set(READING_CHUNK_PARAM, list.param);
      const response = await fetch(url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error("Reading chunk failed");
      const chunk: ReadingChunk<T> = await response.json();
      const merged = appendReadingItems(view.topics, chunk.topics);
      const expanded = { ...view.list, next: chunk.list.next, count: merged.length };

      const update = addressUpdate.then(async () => {
        if (controller.signal.aborted) return;
        const { search, hash } = window.location;
        await navigate({ pathname: location.pathname, search: readingHref(search, expanded, false, companion), hash }, {
          replace: true, preventScrollReset: true, defaultShouldRevalidate: false,
          state: { ...location.state, readingVisitKey: readingVisitKey(location) },
        });
      });
      addressUpdate = update.catch(() => {});
      await update;
      if (controller.signal.aborted) return;
      setView({ ...view, topics: merged, list: expanded, pending: false, failed: false, announcement: m.list_added({ count: merged.length - view.topics.length }),
        focusId: chunk.list.next ? null : merged[view.topics.length]?.id ?? null });
    } catch {
      if (!controller.signal.aborted) setView({ ...view, pending: false, failed: true, announcement: "" });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  return <div ref={container} className="space-y-3" data-reading-list={list.param}>
    {(view.list.older || view.list.restored) && <a href={`${location.pathname}${readingLatestHref(location.search, view.list, companion)}${anchor}`} className="link-ui">{m.list_back_latest()}</a>}
    {children(view.topics)}
    <p role="status" aria-live="polite" aria-atomic="true" className={view.failed ? "ui-help text-destructive" : "sr-only"}>{view.failed ? m.list_load_failed() : view.announcement}</p>
    {view.list.next && <a data-load-more href={next + anchor} rel="next" role={live && !atLimit ? "button" : undefined} className={buttonVariants({ variant: "outline" })}
      onKeyDown={event => { if (live && !atLimit && event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }}
      aria-disabled={view.pending || undefined}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || atLimit) return;
        event.preventDefault();
        void loadMore();
      }}>{m.list_load_more()}</a>}
  </div>;
}
