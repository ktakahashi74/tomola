import { useEffect, useState } from "react";
import { Link } from "react-router";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";
import { useEnabledLangs } from "~/lib/use-enabled-langs";

export type PostedLang = { lang: Lang; state: "available" | "pending" | "unavailable" };

// Said on the window after each read of the status, so that the language menu of the same page does not ask for it again.
export const POSTED_STATUS_EVENT = "tomola:posted-status";
const POLL_MS = 4000;
const POLL_FOR_MS = 10 * 60 * 1000;

// What the author is told right after posting a topic: in which language it was published (a wrong guess can be fixed from here), and into which languages it is being translated,
// as names only: a language turns from grey to ordinary text when its translation is there. Nothing counts readers or reactions, and the notice goes with the page.
// The member's first topic also gets one line of welcome; nothing is recorded for it.
export default function PostedTopicNoticeContent({ topicId, lang, place, firstPost, initial, editHref }: { topicId: number; lang: Lang; place?: string; firstPost: boolean; initial: PostedLang[]; editHref: string }) {
  const [langs, setLangs] = useState(initial);
  const hasTargets = useEnabledLangs().some(target => target !== lang);
  const pending = langs.some(item => item.state === "pending");
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) { clearInterval(timer); return; }
      try {
        const response = await fetch(`/t/${topicId}/posted-status`, { credentials: "same-origin", cache: "no-store", redirect: "manual", headers: { accept: "application/json" } });
        if (!response.ok) return;
        const body = await response.json() as { langs?: PostedLang[] };
        if (!stopped && Array.isArray(body.langs)) {
          setLangs(body.langs);
          window.dispatchEvent(new CustomEvent(POSTED_STATUS_EVENT, { detail: { topicId, langs: body.langs } }));
        }
      } catch { /* Try again at the next tick. */ }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [pending, topicId]);
  const reached = langs.every(item => item.state === "available");
  return <div role="status" className="space-y-1">
    <p className="text-success">{place ? m.posted_topic_public({ place, lang: LANG_LABELS[lang] }) : m.posted_topic_public_no_place({ lang: LANG_LABELS[lang] })} <Link to={editHref} className="ui-meta underline">{m.posted_fix_lang()}</Link></p>
    {hasTargets && <p className="ui-help text-muted-foreground">
      {reached ? m.posted_all_reached() : <>{m.posted_translating()}{" "}
        {langs.map(item => <span key={item.lang} lang={item.lang} className={`me-2 transition-colors ${item.state === "available" ? "text-foreground" : ""}`}>{LANG_LABELS[item.lang]}{item.state === "available" && <span aria-hidden="true"> ✓</span>}</span>)}</>}
    </p>}
    {firstPost && <p className="ui-help text-muted-foreground">{m.posted_first()}</p>}
  </div>;
}

