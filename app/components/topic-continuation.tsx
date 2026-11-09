import { Link } from "react-router";
import type { TopicContinuation as Continuation } from "~/lib/topic-continuation.server";
import { villageName, villagePath } from "~/lib/village-name";
import { villageNameTitle } from "~/lib/village-translation-view";
import { m } from "~/paraglide/messages.js";

export function TopicContinuation({ value, lang }: { value: Continuation | null | undefined; lang: string | null }) {
  if (!value) return null;
  const name = villageName(value.village);
  return <nav data-topic-continuation aria-labelledby={value.topics.length ? "topic-continuation-heading" : undefined} aria-label={value.topics.length ? undefined : name} className="space-y-3 border-t pt-4">
    {value.topics.length > 0 && <><h2 id="topic-continuation-heading" className="font-semibold">{m.village_recent_posts({ name })}</h2><ul className="space-y-2">
      {value.topics.map(topic => <li key={topic.id} className="[overflow-wrap:anywhere]"><Link to={`/t/${topic.id}${lang ? `?lang=${lang}` : ""}`} dir="auto" lang={topic.title.lang} data-translation-pending={topic.title.pending || undefined} className="underline">{topic.title.text || m.headline_empty()}</Link></li>)}
    </ul></>}
    <p className="flex flex-wrap gap-x-4 gap-y-2 ui-meta"><Link to={villagePath(value.village.slug)} title={villageNameTitle(value.village)} className="underline">{m.reading_more_posts({ name })}</Link><Link to="/" className="underline">{m.reading_home()}</Link></p>
  </nav>;
}
