import { useEffect, useRef } from "react";

// Native details still work without scripts. With scripts, dismiss on an outside
// press or Escape, returning keyboard focus only when it was inside the details.
export function useDismissibleDetails() {
  const control = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const element = control.current;
      if (!element?.open) return;
      if (event.type === "pointerdown" && element.contains(event.target as Node)) return;
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const focusInside = element.contains(document.activeElement);
      element.open = false;
      if (event.type === "keydown" && focusInside) element.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  return control;
}
