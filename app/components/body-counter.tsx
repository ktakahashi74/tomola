import { lazy, Suspense } from "react";
import { QuietBoundary, usePageReady } from "~/components/quiet-boundary";

const Content = lazy(() => import("./body-counter-content"));

// Put inside a writing form. The count and its message are loaded after the page is ready, so that they are not part of the page's first script; the server checks the length as before.
export function BodyCounter() {
  return usePageReady() ? <QuietBoundary><Suspense fallback={null}><Content /></Suspense></QuietBoundary> : null;
}
