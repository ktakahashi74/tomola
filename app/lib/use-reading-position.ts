import { useLayoutEffect } from "react";
import { useLocation, type Location } from "react-router";

// Extending a range replaces the address within the same reading visit.
export function readingVisitKey(location: Location): string {
  return location.state?.readingVisitKey ?? location.key;
}

function visibleReadingRow() {
  for (const row of document.querySelectorAll<HTMLElement>("[data-reading-list] :is(li[id^='q-'], [data-reading-id])")) {
    const { top, bottom } = row.getBoundingClientRect();
    if (bottom > 0 && top < window.innerHeight) {
      return { list: row.closest("[data-reading-list]")!.getAttribute("data-reading-list"), id: row.dataset.readingId ?? row.id.slice(2), top };
    }
  }
}

// Expanded lists can have a different initial height from their first batch.
// Retain the departure position on this history entry and restore after the
// router's scroll restoration and the expanded rows have both been committed.
export function useReadingPosition() {
  const { key } = useLocation();
  useLayoutEffect(() => {
    const saved = window.history.state?.tomolaReadingPosition;
    let frame: number | undefined;
    if (saved?.key === key && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const restore = () => {
        const row = saved.row;
        const list = row && document.querySelector(`[data-reading-list="${CSS.escape(row.list)}"]`);
        const id = row && CSS.escape(row.id);
        const anchor = list?.querySelector(`[id="q-${id}"], [data-reading-id="${id}"]`);
        // The restored list can have a "Back to latest" link above its rows.
        window.scrollTo(saved.x, anchor ? window.scrollY + anchor.getBoundingClientRect().top - row.top : saved.y);
      };
      restore();
      frame = requestAnimationFrame(restore);
    }
    const remember = () => window.history.replaceState({ ...window.history.state,
      tomolaReadingPosition: { key, x: window.scrollX, y: window.scrollY, row: visibleReadingRow() },
    }, "");
    document.addEventListener("click", remember, true);
    window.addEventListener("pagehide", remember);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("click", remember, true);
      window.removeEventListener("pagehide", remember);
    };
  }, [key]);
}
