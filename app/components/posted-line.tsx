import { lazy, Suspense } from "react";

const Content = lazy(() => import("./posted-line-content"));

// One line told after a save or a reply (the reply newly followed the topic; the edit was saved). They are shown once, on the page that follows the action, so their
// words are not part of the thread page's first script.
export function PostedLine({ kind }: { kind: "reply-followed" | "edited" }) {
  return <Suspense fallback={null}><Content kind={kind} /></Suspense>;
}
