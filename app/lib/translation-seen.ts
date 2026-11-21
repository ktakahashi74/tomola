import type { SourceLang } from "./languages";
import { documentKey } from "./reading-document";
import { SHARE_LANG_PARAM } from "./share-language";

// Read the small reply to the end: an unread, compressed body can keep the request
// open in the browser, so the page never settles.
const drain = (response: Response) => response.arrayBuffer();

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
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "seen", ids: seen }) }).then(response => { if (response.ok) reports.forEach(ids => reported.add(ids)); return drain(response); }).catch(() => {});
  }, 0);
}

// Each tab remembers successful reports for a fixed window across reloads.
const readStorageKey = "tomola:read-dedupe:v1";
const readLifetime = 1_800_000;
const maxReads = 100;
const fallbackReads = new Map<string, number>();
const inFlightReads = new Set<string>();
let reportedRead = false;

function pruneReads(reads: Map<string, number>, now: number) {
  for (const [key, expiry] of reads) if (!(expiry > now)) reads.delete(key);
  while (reads.size > maxReads) reads.delete(reads.keys().next().value!);
}

function rememberRead(key: string, now: number, save = false): boolean {
  try {
    const saved: Record<string, number> = JSON.parse(sessionStorage.getItem(readStorageKey) ?? "{}");
    const reads = new Map(Object.entries(saved).sort((a, b) => a[1] - b[1]));
    if (save) {
      reads.delete(key);
      reads.set(key, now + readLifetime);
    }
    pruneReads(reads, now);
    if (save || reads.size !== Object.keys(saved).length) {
      sessionStorage.setItem(readStorageKey, JSON.stringify(Object.fromEntries(reads)));
    }
    if (reads.has(key)) return true;
  } catch {
    if (save) fallbackReads.set(key, now + readLifetime);
  }
  pruneReads(fallbackReads, now);
  return fallbackReads.has(key);
}

export function markTopicRead(page: string, lang: SourceLang, isTranslated: boolean, mark?: string): () => void {
  const url = new URL(page, location.href);
  const key = `${url.pathname}:${lang}:${isTranslated ? "tr" : "orig"}`;
  const shared = url.searchParams.has(SHARE_LANG_PARAM);
  const search = (value: string) => {
    const params = new URLSearchParams(value);
    params.delete(SHARE_LANG_PARAM);
    params.delete("posted");
    params.delete("edited");
    params.delete("followed");
    return params.toString();
  };
  const displayedSearch = search(url.search);
  const report = () => {
    if (location.pathname !== url.pathname || search(location.search) !== displayedSearch ||
      inFlightReads.has(key) || rememberRead(key, Date.now())) return;
    const internal = reportedRead || (window.history.state?.key ?? "default") !== documentKey;
    inFlightReads.add(key);
    let host = "";
    try { if (!internal && document.referrer) host = new URL(document.referrer).hostname; } catch { /* No usable host. */ }
    void fetch(`${url.pathname}/translations${location.search}`, { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        intent: "read", ids: [], internal, shared, referrerHost: host, shown: isTranslated ? "translation" : "original", mark,
      }) }).then(async response => {
      if (!response.ok) return drain(response);
      reportedRead = true;
      const result = await response.json();
      if (result?.counted === true) rememberRead(key, Date.now(), true);
    }).catch(() => {}).finally(() => inFlightReads.delete(key));
  };
  if (document.visibilityState === "visible") {
    report();
    return () => {};
  }
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    report();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => document.removeEventListener("visibilitychange", onVisibilityChange);
}
