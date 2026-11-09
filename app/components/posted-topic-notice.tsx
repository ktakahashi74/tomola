import { lazy, Suspense, type ComponentProps } from "react";
import type { PostedLang } from "~/components/posted-topic-notice-content";

export type { PostedLang };
const Content = lazy(() => import("./posted-topic-notice-content"));

// The notice that follows a new topic exists only on the page that is opened by posting; it is not part of the topic page's first script.
export function PostedTopicNotice(props: ComponentProps<typeof Content>) {
  return <Suspense fallback={null}><Content {...props} /></Suspense>;
}
