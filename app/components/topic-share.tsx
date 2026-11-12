import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { buttonVariants } from "~/components/ui/button";
import type { Lang, SourceLang } from "~/lib/languages";
import { cn } from "~/lib/utils";
import { m } from "~/paraglide/messages.js";

const ShareContent = lazy(() => import("./topic-share-content"));

export function TopicShare({ topicId, readingLang, originalLang, floating = false }: { topicId: number; readingLang: SourceLang; originalLang: SourceLang; floating?: boolean }) {
  const control = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <details ref={control} className="relative" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>{m.share_topic()}</summary>
    {open && <Suspense fallback={null}><ShareContent topicId={topicId} readingLang={readingLang} originalLang={originalLang} control={control} floating={floating} /></Suspense>}
  </details>;
}
