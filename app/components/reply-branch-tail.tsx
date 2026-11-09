import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";
import { m } from "~/paraglide/messages.js";

const subscribe = () => () => {};
const clientSnapshot = () => false;
const serverSnapshot = () => true;

// Native toggles own the live state. Keeping the initial open prop stable avoids
// resetting a reader's choice on hydration or loader revalidation.
export function ReplyBranchTail({ openFor, count, children }: { openFor: number | null; count: number; children: ReactNode }) {
  const hydrating = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const [initialQueryTarget] = useState(hydrating ? openFor : null);
  const initiallyOpen = initialQueryTarget !== null;
  const previousTarget = useRef(initialQueryTarget);
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (element.current && element.current.open !== initiallyOpen) element.current.dataset.replyManual = "";
  }, [initiallyOpen]);
  useEffect(() => {
    const changed = previousTarget.current !== openFor;
    previousTarget.current = openFor;
    if (changed && openFor !== null) return afterInitialActivation(() => {
      const details = element.current;
      if (!details || details.open) return;
      details.open = true;
      // On client query navigation, move only when we have just revealed the
      // matching fragment. Opening a reply-form target must not move the form.
      const reply = document.getElementById(`c-${openFor}`);
      if (window.location.hash === `#c-${openFor}` && reply && details.contains(reply)) reply.scrollIntoView();
    });
  }, [openFor]);
  return <details ref={element} open={initiallyOpen} suppressHydrationWarning data-reply-tail="" data-reply-initial-query={initialQueryTarget ?? undefined} className="space-y-3">
    <summary className="link-ui cursor-pointer list-none py-2 ui-meta [&::-webkit-details-marker]:hidden">{m.branch_more_replies({ count })}</summary>
    {children}
  </details>;
}
