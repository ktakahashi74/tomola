import { lazy, Suspense, type ComponentProps } from "react";
import { QuietBoundary, usePageReady } from "~/components/quiet-boundary";
import type DraftAutosaveContent from "./draft-autosave-content";

const Content = lazy(() => import("./draft-autosave-content"));

// Autosave starts after the writing form is ready; its storage and recovery
// work need not enlarge the page's initial script.
export function DraftAutosave(props: ComponentProps<typeof DraftAutosaveContent>) {
  // Keep SSR free of a dehydrated autosave boundary: a delayed module must
  // not hold the departure guard's blocked-navigation effect during hydration.
  return usePageReady() ? <QuietBoundary><Suspense fallback={null}><Content {...props} /></Suspense></QuietBoundary> : null;
}
