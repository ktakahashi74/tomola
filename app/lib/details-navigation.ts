import { useEffect, useState, type RefObject } from "react";

export function useDetailsNavigation(bodyRef: RefObject<HTMLDivElement | null>, html: string) {
  const available = html.includes("<details>");
  const [allOpen, setAllOpen] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!available || !body) return;
    const containers = () => Array.from(body.querySelectorAll("details"));
    const update = () => setAllOpen(containers().every(details => details.open));
    let frame = 0;
    const reveal = (hash = location.hash) => {
      let id: string;
      try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
      const target = document.getElementById(id);
      if (!target || !body.contains(target)) return;
      for (let parent = target.parentElement; parent && parent !== body; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        target.scrollIntoView();
        if (!target.hasAttribute("tabindex")) {
          target.tabIndex = -1;
          target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
        }
        target.focus({ preventScroll: true });
      });
    };
    const navigate = () => reveal();
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.hash) reveal(url.hash);
    };
    let printed: Map<HTMLDetailsElement, boolean> | undefined;
    const beforePrint = () => {
      printed ??= new Map(containers().map(details => [details, details.open]));
      containers().forEach(details => { details.open = true; });
    };
    const afterPrint = () => {
      printed?.forEach((open, details) => { details.open = open; });
      printed = undefined;
      update();
    };
    update();
    navigate();
    body.addEventListener("toggle", update, true);
    document.addEventListener("click", click);
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    window.addEventListener("pageshow", navigate);
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener("toggle", update, true);
      document.removeEventListener("click", click);
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
      window.removeEventListener("pageshow", navigate);
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, [available, bodyRef, html]);
  return { available, allOpen, toggle: () => {
    bodyRef.current?.querySelectorAll("details").forEach(details => { details.open = !allOpen; });
    setAllOpen(!allOpen);
  } };
}
