import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import type { ReadingInfo } from "~/lib/reading";
import { m } from "~/paraglide/messages.js";

export function ReadingToc({ headings, lang, bodyRef, actions, actionMenu }: { headings: ReadingInfo["headings"]; lang: string; bodyRef: RefObject<HTMLDivElement | null>; actions?: ReactNode; actionMenu?: ReactNode }) {
  const sidebar = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (headings.length < 3 || !bodyRef.current) return;
    const elements = headings.map(heading => document.getElementById(heading.id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    function update() {
      timer = undefined;
      // Match the existing anchor landing position, including a small rounding tolerance.
      const first = elements.find(element => element !== null);
      const edge = first ? parseFloat(getComputedStyle(first).scrollMarginTop) || 0 : 0;
      let active: string | null = null;
      for (const element of elements) {
        if (element && element.getBoundingClientRect().top <= edge + 1) active = element.id;
      }
      // A fragment can land below the top edge when the page cannot scroll any farther.
      // Honor that visible destination without moving the page beyond its natural limit.
      if (scrollY + innerHeight >= document.documentElement.scrollHeight - 1) {
        const destination = elements.find(element => element && `#${element.id}` === location.hash);
        const top = destination?.getBoundingClientRect().top ?? -Infinity;
        if (destination && top > edge + 1 && top < innerHeight) active = destination.id;
      }
      setCurrent(sidebar.current?.getClientRects().length ? active : null);
    }
    function schedule() {
      timer ??= setTimeout(update, 100);
    }
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(bodyRef.current);
    return () => {
      clearTimeout(timer);
      resize.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, [headings, bodyRef]);
  useEffect(() => {
    function reveal() {
      const panel = sidebar.current?.querySelector("nav");
      const link = panel?.querySelector('[aria-current="location"]');
      if (!panel || !link || !panel.getClientRects().length) return;
      const bounds = panel.getBoundingClientRect();
      const target = link.getBoundingClientRect();
      // Scroll only the contents panel; scrollIntoView would also move the article.
      if (target.top < bounds.top) panel.scrollTop += target.top - bounds.top;
      else if (target.bottom > bounds.bottom) panel.scrollTop += target.bottom - bounds.bottom;
    }
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [current, headings]);
  const hasHeadings = headings.length >= 3;
  if (!hasHeadings && !actions) return null;
  const links = (fixed = false) => (
    <ol dir="auto" lang={lang} className="space-y-2">
      {headings.map(heading => (
        <li key={heading.id} className={heading.depth === 3 ? "ps-3" : undefined}>
          <a href={`#${heading.id}`} aria-current={fixed && heading.id === current ? "location" : undefined} className={fixed ? "reading-toc-link" : "underline [overflow-wrap:anywhere]"}>{heading.text}</a>
        </li>
      ))}
    </ol>
  );
  return (
    <>
      {hasHeadings && <nav aria-label={m.reading_toc()} className="reading-toc ui-help text-muted-foreground">
        <details className="reading-toc-folded">
          <summary className="cursor-pointer">{m.reading_toc()}</summary>
          <div className="mt-3">{links()}</div>
        </details>
      </nav>}
      <div className="reading-toc-track">
        <div ref={sidebar} className="reading-toc-sidebar ui-help text-muted-foreground">
          {hasHeadings && <nav aria-label={m.reading_toc()}>
            <p className="mb-3 font-semibold">{m.reading_toc()}</p>
            {links(true)}
          </nav>}
          {actions && <div className={hasHeadings ? "mt-4 border-t pt-4" : undefined}>{actions}</div>}
        </div>
      </div>
      {actionMenu}
    </>
  );
}
