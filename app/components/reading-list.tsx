import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useFetcher, useLocation } from "react-router";
import { appendReadingItems, readingHref, readingLatestHref, READING_BATCH, READING_RESTORE_MAX, type ReadingPage } from "~/lib/reading-page";
import { useReadingPosition } from "~/lib/use-reading-position";
import { useReadingSearch } from "~/lib/use-reading-search";
import { buttonVariants } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

type Chunk<T> = { topics: T[]; list: ReadingPage };
type Section = "personal" | "alternativesList" | "objectionsList";
type Result<T> = Chunk<T> & Partial<Record<Section, Chunk<T> | null>>;

export function ReadingList<T extends { id: number }>({ topics, list, section, children }: Chunk<T> & { section?: Section; children: (topics: T[]) => ReactNode }) {
  const location = useLocation();
  // History returns mount the restored range. Appending keeps this key and
  // row DOM nodes, including the current focus and the frozen new-post marks.
  return <ReadingListView key={`${location.key}:${location.pathname}:${location.search}`} topics={topics} list={list} section={section}>{children}</ReadingListView>;
}

function ReadingListView<T extends { id: number }>({ topics, list, section, children }: Chunk<T> & { section?: Section; children: (topics: T[]) => ReactNode }) {
  const location = useLocation();
  const search = useReadingSearch();
  useReadingPosition();
  const fetcher = useFetcher<Result<T>>();
  const container = useRef<HTMLDivElement>(null);
  const live = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const [view, setView] = useState({ source: topics, topics, list, announcement: "", pending: false, data: undefined as Result<T> | undefined, focusId: null as number | null });
  // Accept ordinary revalidation (including removals and visibility changes)
  // and each completed chunk before drawing its rows, without an extra render.
  if (view.source !== topics && !view.pending) {
    setView({ ...view, source: topics, topics, list, announcement: "", focusId: null });
  } else if (view.pending && fetcher.state === "idle" && fetcher.data && fetcher.data !== view.data) {
    const chunk = section ? fetcher.data[section] : fetcher.data;
    if (chunk) {
      const merged = appendReadingItems(view.topics, chunk.topics);
      const added = merged.length - view.topics.length;
      setView({ ...view, topics: merged, list: { ...view.list, next: chunk.list.next, count: merged.length },
        pending: false, data: fetcher.data, announcement: m.list_added({ count: added }),
        focusId: chunk.list.next ? null : merged[view.topics.length]?.id ?? null });
    }
  }
  useEffect(() => {
    if (!view.announcement) return;
    const url = new URL(window.location.href);
    url.search = readingHref(url.search, view.list, false);
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event("tomola:list-address"));
    // When the last control disappears, focus the first appended row instead.
    if (view.focusId !== null) container.current?.querySelector<HTMLAnchorElement>(`#q-${view.focusId} a, [data-reading-id="${view.focusId}"] a`)?.focus({ preventScroll: true });
  }, [view.list, view.announcement, view.focusId]);
  const next = `${location.pathname}${readingHref(search, view.list, true)}`;
  const atLimit = view.topics.length + READING_BATCH > READING_RESTORE_MAX;
  return <div ref={container} className="space-y-3" data-reading-list={list.param}>
    {view.list.older && <a href={`${location.pathname}${readingLatestHref(search, view.list)}`} className="link-ui">{m.list_back_latest()}</a>}
    {children(view.topics)}
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{view.announcement}</p>
    {view.list.next && <a data-load-more href={next} rel="next" role={live && !atLimit ? "button" : undefined} className={buttonVariants({ variant: "outline" })}
      onKeyDown={event => { if (live && !atLimit && event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }}
      aria-disabled={fetcher.state !== "idle" || undefined}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || atLimit) return;
        event.preventDefault();
        if (fetcher.state !== "idle") return;
        setView({ ...view, pending: true, announcement: "", data: fetcher.data });
        // The home is an index route; fetchers otherwise load its parent.
        void fetcher.load(location.pathname === "/" ? `${next}${next.includes("?") ? "&" : "?"}index` : next);
      }}>{m.list_load_more()}</a>}
  </div>;
}
