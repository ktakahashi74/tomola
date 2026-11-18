import { useLayoutEffect } from "react";
import { useLocation } from "react-router";

// Expanded lists can have a different initial height from their first batch.
// Retain the departure position on this history entry and restore after the
// router's scroll restoration and the expanded rows have both been committed.
export function useReadingPosition() {
  const { key } = useLocation();
  useLayoutEffect(() => {
    const saved = window.history.state?.tomolaReadingPosition;
    let frame: number | undefined;
    if (saved?.key === key && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const restore = () => window.scrollTo(saved.x, saved.y);
      restore();
      frame = requestAnimationFrame(restore);
    }
    const remember = () => window.history.replaceState({ ...window.history.state,
      tomolaReadingPosition: { key, x: window.scrollX, y: window.scrollY },
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
