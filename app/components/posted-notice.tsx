import { useEffect } from "react";

// The address that carried the notice (?posted=, ?edited=, ?followed=) is cleaned a few seconds after the notice appears, so that the address copied from the bar does not say "just posted".
export function useDropNoticeParams(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("posted") && !url.searchParams.has("edited") && !url.searchParams.has("followed")) return;
      url.searchParams.delete("posted");
      url.searchParams.delete("edited");
      url.searchParams.delete("followed");
      window.history.replaceState(window.history.state, "", url);
    }, 6000);
    return () => clearTimeout(timer);
  }, [active]);
}
