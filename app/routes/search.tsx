import { PendingText } from "~/components/pending-text";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { data, Form, Link, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/search";
import { TranslationLabel } from "~/components/translation-label";
import { ListMeta } from "~/components/list-meta";
import { LocalTime } from "~/components/local-time";
import { PageHeader } from "~/components/page-header";
import { AuthorLink } from "~/components/author-link";
import { requireMember } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { languageLabel } from "~/lib/language-label";
import { combinedHits, combinedSearch, type CombinedHit } from "~/lib/combined-search.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { checkQuery, MAX_QUERY_LENGTH } from "~/lib/search";
import { m } from "~/paraglide/messages.js";

// Member search combines independent literal matches with semantic neighbors, at most 20.
// Count one request toward the shared search limit; an unavailable embedding leaves literal results usable.
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  const out = new Headers({ "Cache-Control": "private, no-store" });
  for (const name of ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]) {
    const value = loaderHeaders.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

// Every loader call embeds the query at a cost and increments the search count. React Router revalidates the current loader after actions elsewhere, such as header controls,
// so skip revalidation after other actions or navigation with unchanged ?q= and ?lang=. Revalidate only
// on search submission from the header or page, including repeated identical queries, or display-language changes that alter the results' language.
export function shouldRevalidate({ currentUrl, nextUrl, formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formAction === "/search") return defaultShouldRevalidate;
  const same =
    currentUrl.pathname === nextUrl.pathname && currentUrl.searchParams.get("q") === nextUrl.searchParams.get("q") && currentUrl.searchParams.get("lang") === nextUrl.searchParams.get("lang");
  return same ? false : defaultShouldRevalidate;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.search_title() }];
}

type SearchState = {
  state: "start" | "results" | "too_long" | "rate_limited";
  q: string;
  hits: CombinedHit[];
  literalOnly: boolean;
  lang: string;
  carryLang: string | null;
  // Minutes to wait when rate_limited.
  retryMinutes: number;
};
const view = (state: SearchState["state"], q: string, extra: Partial<Omit<SearchState, "state" | "q">> = {}): SearchState => ({ state, q, hits: [], literalOnly: false, lang: "", carryLang: null, retryMinutes: 0, ...extra });

export async function loader({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const language = { lang: displayLangFor(request, profile), carryLang: langCarry(request) };
  const raw = new URL(request.url).searchParams.get("q") ?? "";
  if (raw.trim() === "") return view("start", "", language);
  const checked = checkQuery(raw);
  // For overlong queries, return only the allowed prefix to the input field.
  if (!checked.ok) return data(view("too_long", [...raw].slice(0, MAX_QUERY_LENGTH).join(""), language), { status: 400 });
  const rate = await hitMemberLimit(db, "search", user.id);
  if (!rate.allowed) {
    return data(view("rate_limited", checked.query, { ...language, retryMinutes: Math.max(1, Math.ceil(rate.retryAfterSeconds / 60)) }), {
      status: 429,
      headers: rateLimitHeaders(rate),
    });
  }
  const opts = { readLangs: screenReadLangsFor(request, profile), displayLang: language.lang, carryLang: language.carryLang };
  const result = await combinedSearch(db, checked.query, opts);
  const hits = await combinedHits(db, checked.query, result, opts);
  return view("results", checked.query, { hits, literalOnly: result.literalOnly, lang: opts.displayLang, carryLang: opts.carryLang });
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { state, q, hits, retryMinutes, literalOnly, lang, carryLang } = loaderData;
  return (
    <main className="space-y-4">
      <PageHeader title={m.search_title()} purpose={m.search_purpose()} />
      <Form method="get" action="/search" role="search" className="flex gap-2">
        {carryLang && <input type="hidden" name="lang" value={carryLang} />}
        <Input
          type="search"
          name="q"
          defaultValue={q}
          maxLength={MAX_QUERY_LENGTH}
          required
          aria-label={m.nav_search_label()}
          className="w-full"
        />
        <Button variant="default" type="submit" className="shrink-0 whitespace-nowrap">
          {m.search_button()}
        </Button>
      </Form>
      {state === "too_long" && <p role="alert">{m.search_error_too_long({ max: MAX_QUERY_LENGTH })}</p>}
      {state === "rate_limited" && <p role="alert">{m.search_rate_limited({ minutes: retryMinutes })}</p>}
      {state === "results" && (
        <section className="space-y-2">
          <h2 className="heading-2">{m.search_results_for({ q, count: hits.length })}</h2>
          {literalOnly && <p role="status">{m.search_literal_only()}</p>}
          {hits.length === 0 ? <p className="ui-help text-muted-foreground">{m.search_no_results()}</p> : <HitList hits={hits} />}
          <a className="link-ui text-sm" href={`/search.md?${new URLSearchParams({ q, ...(carryLang ? { lang } : {}) })}`}>{m.search_markdown()}</a>
        </section>
      )}
    </main>
  );
}

function HitList({ hits }: { hits: CombinedHit[] }) {
  return (
    <ul className="divide-y">
      {hits.map((hit) => {
        const translation = hit.excerpt.translation ?? hit.title.translation;
        return (
        <li key={hit.id} className="topic-row space-y-1">
          <Link to={hit.href} dir="auto" lang={hit.title.lang} className="topic-title link-ui" data-translation-pending={hit.title.pending || undefined}>
            {hit.title.text || m.headline_empty()}
          </Link>
          {" "}<LocalTime iso={hit.createdAt.toISOString()} className="topic-date ui-meta text-muted-foreground" />
          <ListMeta items={[
            { key: "match", badge: true, content: <Badge variant="secondary">{hit.matchKind === "literal" ? m.search_match_literal() : m.search_match_semantic()}</Badge> },
            // A post is what is expected; only a reply is marked.
            hit.kind === "reply" && { key: "reply", badge: true, content: <Badge variant="secondary">{m.search_kind_reply()}</Badge> },
            { key: "language", badge: true, content: <Tooltip><TooltipTrigger render={<Badge variant="secondary" />}>
              {languageLabel(hit.lang)}
            </TooltipTrigger><TooltipContent role="tooltip">{m.search_original_lang()}</TooltipContent></Tooltip> },
            !!hit.authorHandle && { key: "author", content: <AuthorLink handle={hit.authorHandle} name={hit.authorName} /> },
            !!translation && { key: "translation", badge: true, content: <TranslationLabel kind={translation.kind} engine={translation.engine} model={translation.model} fallback={translation.fallback} stale={translation.stale} structureMismatch={translation.structureMismatch || hit.title.translation?.structureMismatch} /> },
            (hit.title.pending || hit.excerpt.pending) && { key: "pending", content: <span className="ui-meta"><PendingText short /></span> },
            hit.excerpt.unavailable && { key: "unavailable", content: <span role="status" className="ui-meta">{m.translation_unavailable()}</span> },
          ]} />
          {hit.match ? <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">
              {hit.match.source === "original" ? <><span>{m.search_match_original()}</span>{" "}<span>{languageLabel(hit.match.lang)}</span></> : hit.match.translation && <TranslationLabel {...hit.match.translation} />}
            </div>
            <p dir="auto" lang={hit.match.lang} className="break-words text-sm">{hit.match.text}</p>
          </div> : !(hit.title.fromBody && hit.title.text !== "" && hit.excerpt.text.startsWith(hit.title.text)) && (
            <p dir="auto" lang={hit.excerpt.lang} className="text-sm">
              {hit.excerpt.text}
            </p>
          )}
        </li>
        );
      })}
    </ul>
  );
}
