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
