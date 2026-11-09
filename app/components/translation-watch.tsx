import { useEffect, useRef } from "react";
import { POSTED_STATUS_EVENT } from "~/components/posted-topic-notice-content";
import type { Lang } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";

// For the author of an article whose translations are still being made: ask for the state of the translations every 10 seconds while the page is on screen, for up to 6 minutes, so that the
// languages the translation has reached turn from muted to normal in the language menu. It reads only the names of the languages (the same small entry as the notice that follows a post:
// /t/<id>/posted-status), not the page. When that notice is on screen it already reads the entry every 4 seconds and says so in an event, which this uses instead of asking again.
// It draws nothing and counts nothing; a failed read is ignored. `onSettled` gets the languages that are no longer waiting.
export function TranslationWatch({ topicId, onSettled }: { topicId: number; onSettled: (langs: Lang[]) => void }) {
  const enabledKey = useEnabledLangs().join(",");
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    const enabled = enabledKey.split(",") as Lang[];
    let rounds = 0;
    let heard = 0;
    const apply = (langs: Array<{ lang: Lang; state: string }>) => settled.current(enabled.filter(lang => !langs.some(item => item.lang === lang && item.state === "pending")));
    const listen = (event: Event) => {
      const detail = (event as CustomEvent<{ topicId: number; langs: Array<{ lang: Lang; state: string }> }>).detail;
      if (detail?.topicId !== topicId) return;
      heard = Date.now();
      apply(detail.langs);
    };
    window.addEventListener(POSTED_STATUS_EVENT, listen);
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible" || Date.now() - heard < 8000) return;
      if (++rounds > 36) { window.clearInterval(timer); return; }
      try {
        const response = await fetch(`/t/${topicId}/posted-status`, { credentials: "same-origin", cache: "no-store", redirect: "manual", headers: { accept: "application/json" } });
        if (!response.ok) return;
        const body = await response.json() as { langs?: Array<{ lang: Lang; state: string }> };
        if (Array.isArray(body.langs)) apply(body.langs);
      } catch { /* Try again at the next tick. */ }
    }, 10_000);
    return () => { window.removeEventListener(POSTED_STATUS_EVENT, listen); window.clearInterval(timer); };
  }, [topicId, enabledKey]);
  return null;
}
