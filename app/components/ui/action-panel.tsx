import type { ComponentProps, ReactNode } from "react";
import { PersistentDetails } from "~/components/persistent-details";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

// Three ways to hide something; pick by use.
// 1. ActionPanel (this file): an action such as report, delete or edit. A small button with no triangle; pressing it opens a panel below. Works without JavaScript.
// 2. MoreInfo (more-info.tsx): an explanation or a rule. A small fold, labelled with what is inside, at the end of a sentence that opens the rest in place.
// 3. A plain <details> with its triangle: only for settings that are rarely used (advanced settings, a village's management). Do not use it in the reading screens.
export function ActionPanel({ label, children, className, summaryClassName, summaryProps, ...props }: { label: ReactNode; children: ReactNode; summaryClassName?: string; summaryProps?: Omit<ComponentProps<"summary">, "children" | "className"> } & Omit<ComponentProps<"details">, "children">) {
  return <PersistentDetails {...props} className={cn("action-panel", className)}>
    <summary {...summaryProps} className={cn(buttonVariants({ variant: "ghost", size: "xs" }), "cursor-pointer text-muted-foreground", summaryClassName)}>{label}</summary>
    <div className="mt-2">{children}</div>
  </PersistentDetails>;
}
