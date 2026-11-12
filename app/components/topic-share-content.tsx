import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useRouteLoaderData } from "react-router";
import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/copy-text-button";
import { LANG_LABELS, type Lang, type SourceLang } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { m } from "~/paraglide/messages.js";

export default function ShareContent({ topicId, readingLang, originalLang, control, floating }: {
  topicId: number; readingLang: SourceLang; originalLang: SourceLang; control: RefObject<HTMLDetailsElement | null>; floating: boolean;
}) {
  const enabled = useEnabledLangs();
  const [lang, setLang] = useState<Lang>(enabled.find(lang => lang === readingLang) ?? enabled[0]);
  const [failed, setFailed] = useState(false);
  const select = useRef<HTMLSelectElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRouteLoaderData("root") as { siteOrigin?: string } | undefined;
  const url = new URL(`/t/${topicId}?lang=${lang}`, root?.siteOrigin ?? window.location.origin).href;
  useLayoutEffect(() => {
    function position() {
      if (!control.current || !panel.current) return;
      const anchor = control.current.getBoundingClientRect();
      const { width, height } = panel.current.getBoundingClientRect();
      const left = Math.max(16, Math.min(anchor.right - width, innerWidth - width - 16));
      panel.current.style.left = `${left - (floating ? 0 : anchor.left)}px`;
      if (floating) {
        const top = anchor.bottom + height + 16 <= innerHeight ? anchor.bottom + 4 : anchor.top - height - 4;
        panel.current.style.top = `${Math.max(16, Math.min(top, innerHeight - height - 16))}px`;
      }
    }
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    const layout = new ResizeObserver(position);
    layout.observe(document.body);
    if (control.current?.parentElement) layout.observe(control.current.parentElement);
    if (panel.current) layout.observe(panel.current);
    return () => { window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true); layout.disconnect(); };
  }, [control, floating]);
  useEffect(() => {
    select.current?.focus({ preventScroll: true });
    function close(event: PointerEvent | KeyboardEvent) {
      const element = control.current;
      if (!element) return;
      if (event instanceof KeyboardEvent) {
        if (floating && event.key === "Tab" && panel.current?.contains(document.activeElement)) {
          const controls = panel.current.querySelectorAll<HTMLElement>('select:not([disabled]), button:not([disabled]), a[href]');
          const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
          if (document.activeElement === edge) {
            event.preventDefault();
            element.open = false;
            element.querySelector("summary")?.focus({ preventScroll: true });
          }
          return;
        }
        if (event.key !== "Escape") return;
        const focusInside = element.contains(document.activeElement) || panel.current?.contains(document.activeElement);
        element.open = false;
        if (focusInside) element.querySelector("summary")?.focus({ preventScroll: true });
      } else if (!element.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) element.open = false;
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [control, floating]);
  async function share() {
    setFailed(false);
    try { await navigator.share({ url }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true); }
  }
  const content = <div ref={panel} data-topic-share="" role="group" aria-label={m.share_topic()} className={`${floating ? "fixed" : "absolute mt-1"} z-50 w-56 max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md`}>
    <select ref={select} aria-label={m.reading_lang_label()} value={lang} onChange={event => { setLang(event.target.value as Lang); setFailed(false); }} className="w-full rounded border bg-background p-1 text-sm">
      {enabled.map(value => <option key={value} value={value}>{value === originalLang ? m.reading_lang_original({ name: LANG_LABELS[value] }) : LANG_LABELS[value]}</option>)}
    </select>
    <div className="flex flex-col items-start gap-2">
      <CopyTextButton key={url} text={url} label={m.share_copy_link()} copiedLabel={m.open_in_ai_copied()} />
      {typeof navigator.share === "function" && <Button type="button" variant="outline" onClick={() => void share()}>{m.share_native()}</Button>}
      {failed && <span role="status" className="ui-meta">{m.error_unexpected()}</span>}
    </div>
  </div>;
  return floating ? createPortal(content, document.body) : content;
}
