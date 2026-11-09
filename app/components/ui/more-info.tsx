import type { ReactNode } from "react";
import { PersistentDetails } from "~/components/persistent-details";
import { cn } from "~/lib/utils";

// A fold whose visible label says what is inside (the question it answers), never a bare "More": a bare word tells the reader nothing and only adds clutter.
// Put it at the end of a short sentence. The rest (a rule, how it works) opens in place under it; the label stays, so keyboard focus is not lost and it can be closed again. Works without JavaScript.
// Do not put it inside a <p>: a <details> start tag closes an open <p>, which breaks hydration (PageHeader's purpose row is a div for this reason).
// `name` adds what it is about for screen readers when the label alone does not say it; it is added to the visible label, never replaces it.
// Say what matters to the reader first, and keep the mechanism in here (the voice rule).
export function MoreInfo({ children, label, name, className }: { children: ReactNode; label: string; name?: string; className?: string }) {
  const visible = label;
  return <PersistentDetails className={cn("more-info", className)}>
    <summary aria-label={name ? `${visible} ${name}` : undefined}>{visible}</summary>
    <span className="more-info-body">{children}</span>
  </PersistentDetails>;
}
