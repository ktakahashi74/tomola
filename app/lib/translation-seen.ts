import { documentKey } from "./reading-document";
import { SHARE_LANG_PARAM } from "./share-language";

// Browser-only, coalesced once per render turn. Reading HTML never writes this.
const pending = new Set<number>();
const pendingReports = new Set<readonly number[]>();
// A fresh loader result can contain the same row IDs after a source revision.
// Deduplicate the displayed snapshot, not those IDs for the browser's lifetime.
const reported = new WeakSet<readonly number[]>();
let timer: ReturnType<typeof setTimeout> | undefined;
export function markTranslationSeen(ids: readonly number[]): void {
  if (reported.has(ids)) return;
  if (document.visibilityState !== "visible") {
    const page = location.pathname + location.search;
    document.addEventListener("visibilitychange", () => { if (page === location.pathname + location.search) markTranslationSeen(ids); }, { once: true });
    return;
  }
  ids.forEach(id => pending.add(id));
  if (!pending.size) return;
  pendingReports.add(ids);
  if (timer !== undefined) return;
  const page = location.pathname + location.search;
  timer = setTimeout(() => {
    timer = undefined;
    const seen = [...pending]; pending.clear();
    const reports = [...pendingReports]; pendingReports.clear();
    if (page !== location.pathname + location.search) return;
    void fetch(`${location.pathname}/translations${location.search}`, { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "seen", ids: seen }) }).then(response => { if (response.ok) reports.forEach(ids => reported.add(ids)); }).catch(() => {});
  }, 0);
}

// Reading reports share the existing browser-only lazy notification module.
let reportedDocument = false;
type ReadingDisplay = { page: string; sent?: boolean };
function readingPageKey(page: string): string {
  const url = new URL(page, location.href);
  url.searchParams.delete(SHARE_LANG_PARAM);
  url.hash = "";
  return url.href;
}
// A router catching up with a share-card address change keeps the same notice.
export function readingDisplayFor(previous: ReadingDisplay, page: string): ReadingDisplay {
  return readingPageKey(previous.page) === readingPageKey(page) ? previous : { page };
}
export function markTopicRead(display: ReadingDisplay): () => void {
  const { page } = display;
  // Share-card annotation changes only the address bar, without router navigation.
  // Keep the arrival hint while comparing the actual display without that hint.
  const shown = readingPageKey(page);
  const shared = new URL(page, location.href).searchParams.has(SHARE_LANG_PARAM);
  const internal = reportedDocument || (window.history.state?.key ?? "default") !== documentKey;
  const report = () => {
    if (document.visibilityState !== "visible" || readingPageKey(location.pathname + location.search) !== shown || display.sent) return;
    display.sent = reportedDocument = true;
    let host = "";
    try { if (!internal && document.referrer) host = new URL(document.referrer).hostname; } catch { /* No usable host. */ }
    void fetch(`${location.pathname}/translations${location.search}`, { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "read", ids: [], internal, shared, referrerHost: host }) }).catch(() => {});
  };
  report();
  document.addEventListener("visibilitychange", report);
  return () => document.removeEventListener("visibilitychange", report);
}
