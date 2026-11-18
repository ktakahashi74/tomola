import { useSyncExternalStore } from "react";
import { useLocation } from "react-router";

const subscribe = (callback: () => void) => {
  window.addEventListener("tomola:list-address", callback);
  window.addEventListener("popstate", callback);
  return () => {
    window.removeEventListener("tomola:list-address", callback);
    window.removeEventListener("popstate", callback);
  };
};

// replaceState records the expanded range without navigating/reloading loaders.
// Reading controls and return links still need the current browser address.
export function useReadingSearch() {
  const location = useLocation();
  return useSyncExternalStore(subscribe, () => window.location.search, () => location.search);
}
