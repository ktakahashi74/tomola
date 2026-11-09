import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

// The head of a screen, in one shape.
// Row 1: the heading (left) and the screen's own actions (right). `hideTitle` keeps the h1 for screen readers but draws nothing (use it when the place is already clear from the side column or the header).
// Row 2 (only when it is needed; a div, so that MoreInfo's details may sit inside it): one line of purpose, for a first-time or signed-out reader. Anything longer goes into MoreInfo.
// Row 3 (only when it is needed): the switches inside the screen (tabs, order, filter), in one row.
// `heading` replaces the default h1 (give it the class heading-1 and the same h1 element).
export function PageHeader({ title, hideTitle = false, heading, actions, purpose, switches, className }: {
  title: string;
  hideTitle?: boolean;
  heading?: ReactNode;
  actions?: ReactNode;
  purpose?: ReactNode;
  switches?: ReactNode;
  className?: string;
}) {
  const hasRow1 = !hideTitle || actions != null || heading != null;
  return <div className={cn("space-y-2", className)}>
    {hasRow1 && <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", hideTitle && heading == null ? "justify-end" : "justify-between")}>
      {heading ?? <h1 className={hideTitle ? "sr-only" : "heading-1"}>{title}</h1>}
      {actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>}
    {!hasRow1 && <h1 className="sr-only">{title}</h1>}
    {purpose != null && <div className="ui-help text-muted-foreground">{purpose}</div>}
    {switches != null && <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">{switches}</div>}
  </div>;
}
