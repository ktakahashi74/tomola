import { useEffect, useEffectEvent } from "react";
import { useRevalidator } from "react-router";

export default function NushiStatusWatches({ requestIds }: { requestIds: string[] }) {
  return requestIds.map(requestId => <NushiStatusWatch key={requestId} requestId={requestId} />);
}

function NushiStatusWatch({ requestId }: { requestId: string }) {
  const revalidator = useRevalidator();
  const settled = useEffectEvent(() => { void revalidator.revalidate(); });
  useEffect(() => {
    let remaining = 5 * 60_000, visibleSince = document.hidden ? undefined : Date.now();
    const withinBudget = () => remaining > (visibleSince === undefined ? 0 : Date.now() - visibleSince);
    let attempts = 0, stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const schedule = () => {
      if (!stopped && !document.hidden && attempts < 40 && withinBudget()) {
        timer = setTimeout(check, Math.min(2000 * 1.5 ** attempts, 10_000));
      }
    };
    const check = async () => {
      if (stopped || document.hidden || attempts >= 40 || !withinBudget()) return;
      attempts++;
      const current = new AbortController();
      controller = current;
      try {
        const response = await fetch(`/nushi/request/${encodeURIComponent(requestId)}/status`, {
          credentials: "same-origin", cache: "no-store", redirect: "manual",
          headers: { accept: "application/json" },
          signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
        });
        if (current.signal.aborted || stopped || document.hidden) return;
        if ([401, 403, 404].includes(response.status)) { stopped = true; settled(); return; }
        if (response.ok) {
          const value = await response.json() as { state?: string };
          if (current.signal.aborted || stopped || document.hidden) return;
          if (value.state && ["answered", "failed", "cancelled"].includes(value.state)) {
            stopped = true; settled(); return;
          }
        }
      } catch { /* Retry transient failures within the same bounded watch. */ }
      finally {
        if (controller === current) { controller = undefined; schedule(); }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
      if (document.hidden) {
        if (visibleSince !== undefined) remaining -= Date.now() - visibleSince;
        visibleSince = undefined;
      } else {
        visibleSince ??= Date.now();
        void check();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true; clearTimeout(timer); controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [requestId]);
  return null;
}
