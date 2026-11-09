import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ActionPanel } from "~/components/ui/action-panel";
import { m } from "~/paraglide/messages.js";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

// A disclosure keeps the existing controls (and their dialogs) intact. Its
// native summary opens with Enter/Space; Tab follows the controls in order.
export function ReadingActionMenu({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    // Portalled controls and the AI backdrop belong to this interaction too.
    function portalled(target: EventTarget | null) {
      return target instanceof Element && target.closest('[data-slot="dropdown-menu-content"], [role="dialog"], [data-slot="dialog-overlay"], [data-topic-share]');
    }
    function inside(target: EventTarget | null) {
      return target instanceof Node && (panel.current?.contains(target) || portalled(target));
    }
    function close(event: PointerEvent | KeyboardEvent) {
      const element = panel.current;
      if (!element) return;
      if (portalled(event.target)) return;
      if (event instanceof KeyboardEvent) {
        if (event.key === "Tab") {
          clearTimeout(focusTimer);
          focusTimer = setTimeout(() => {
            if (panel.current && (!document.hasFocus() || !inside(document.activeElement))) panel.current.open = false;
          }, 0);
          return;
        }
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const focusInside = element.contains(document.activeElement);
        element.open = false;
        if (focusInside) element.querySelector("summary")?.focus({ preventScroll: true });
      } else if (!inside(event.target)) element.open = false;
    }
    function focus() {
      // Let a portalled control finish transferring focus before checking it.
      queueMicrotask(() => { if (panel.current && !inside(document.activeElement)) panel.current.open = false; });
    }
    const element = panel.current;
    function follow(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('a[href$="#reply"]') && element) element.open = false;
    }
    element?.addEventListener("click", follow);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    document.addEventListener("focusin", focus);
    return () => { clearTimeout(focusTimer); element?.removeEventListener("click", follow); document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); document.removeEventListener("focusin", focus); };
  }, [open]);
  if (!mounted) return null;
  return createPortal(<ActionPanel ref={panel} className="reading-action-menu" label="…" summaryProps={{ "aria-label": m.reading_actions_label() }}
    summaryClassName="size-10 border-border bg-background text-foreground shadow-md"
    onToggle={event => setOpen(event.currentTarget.open)}>
    {open && <div className="reading-action-menu-content rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">{children}</div>}
  </ActionPanel>, document.body);
}
