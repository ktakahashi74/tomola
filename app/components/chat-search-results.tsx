import { Link } from "react-router";
import type { ChatSearchHit } from "~/lib/village-chat-search.server";
import { LocalTime } from "./local-time";
import { m } from "~/paraglide/messages.js";

export function ChatSearchResults({ hits, slug, linkLang }: { hits: ChatSearchHit[]; slug: string; linkLang: string | null }) {
  return <ul className="divide-y" aria-label={m.chat_search_results()}>
    {hits.map(hit => <li key={hit.id} className="space-y-2 py-3">
      <Link reloadDocument className="block space-y-1 rounded outline-offset-4 hover:underline focus-visible:outline-2" to={`/v/${slug}/chat?${new URLSearchParams({ at: hit.id, from: "search", ...(linkLang ? { lang: linkLang } : {}) })}#chat-${hit.id}`}>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 ui-meta text-muted-foreground">
          <span>{hit.authorName && <><bdi>{hit.authorName}</bdi>{" "}</>}{hit.author ? `@${hit.author}` : m.account_delete_member()}</span>
          <LocalTime iso={hit.createdAt} style="stamp" />
        </span>
        {hit.matches.map(match => <span key={match.source} className="block space-y-1">
          <span className="block ui-meta text-muted-foreground">{match.source === "original" ? m.search_match_original() : m.chat_search_match_translation()}</span>
          <span lang={match.lang} dir="auto" className="block whitespace-pre-wrap [overflow-wrap:anywhere]">{match.excerpt.before}<mark>{match.excerpt.match}</mark>{match.excerpt.after}</span>
        </span>)}
      </Link>
    </li>)}
  </ul>;
}
