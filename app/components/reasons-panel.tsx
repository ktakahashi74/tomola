import { Link } from "react-router";
import { PendingText } from "~/components/pending-text";
import { EntryReactions } from "~/components/reactions";
import { TranslationLabel } from "~/components/translation-label";
import { AuthorLink } from "~/components/author-link";
import { MoreInfo } from "~/components/ui/more-info";
import { type Lang } from "~/lib/languages";
import { languageLabel } from "~/lib/language-label";
import type { ReasonExcerpt } from "~/lib/reasons.server";
import { POSITIONS, type Position } from "~/lib/stances";
import type { ReactionsView } from "~/lib/vote-ui";
import { m } from "~/paraglide/messages.js";

// The reasons panel of a question page: up to three tagged replies per position, always in the order agree, disagree, neither, whatever the reader's stance.
// Replies are drawn by lot to spread their original languages. After choosing a language (or exhausting the unseen languages), prefer replies with at least
// one counted Insightful, without using the number of presses. The draw is shared by all readers and changes once a day (UTC); the panel explains this rule.
// An empty daily selection shows one entry point to the reply form. Otherwise a position without a picked reply opens the form with that mark chosen.
//
// Each reply is shown as a plain-text excerpt (not its HTML: the same reply is also in the list of the thread, and two copies would repeat footnote ids and let the keyboard focus
// enter clipped content). "Read more" opens the reply in the thread and is shown only when the excerpt is shorter than the reply.
//
// It takes props only (no loader data is read here), like the other panels.

// One picked reply. `lang` is the original language of the text (the writer's home area is not part of it).
export type ReasonView = {
  id: number;
  lang: Lang;
  authorHandle: string;
  authorName?: string | null;
  excerpt: ReasonExcerpt;
  reactions: ReactionsView;
  // Whether the viewer wrote it (nobody can press Insightful on their own post).
  own: boolean;
  // Where the reply is in the thread (page and anchor), for "Read more".
  location: string;
  // The link "Reconsider my stance", given only to a viewer who holds a stance on this question.
  reviewHref: string | null;
};

const HEADINGS: Record<Position, () => string> = {
  agree: () => m.stance_tag_agree(),
  disagree: () => m.stance_tag_disagree(),
  neither: () => m.stance_tag_neither(),
};

export function ReasonsPanel({
  questionId,
  reasons,
  loadedAt,
  langParam,
  readingLang,
  reader = false,
}: {
  reader?: boolean;
  questionId: number;
  reasons: Record<Position, ReasonView[]>;
  loadedAt?: string;
  langParam: string | null;
  readingLang: Lang;
}) {
  const lang = langParam ? `lang=${langParam}&` : "";
  if (POSITIONS.every((position) => reasons[position].length === 0)) {
    return (
      <section id="reasons" className="border-t pt-4">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span>{m.reasons_empty_help()}</span>
          {!reader && <Link to={`/t/${questionId}${langParam ? `?lang=${langParam}` : ""}#reply`} className="underline">{m.reasons_write()}</Link>}
        </p>
      </section>
    );
  }
  return (
    <section id="reasons" className="space-y-3 border-t pt-4" aria-labelledby="reasons-heading">
      <h2 id="reasons-heading" className="text-lg font-semibold">
        {m.reasons_title()}
      </h2>
      <div className="ui-meta">
        <MoreInfo label={m.reasons_rule_summary()}><span className="ui-help text-muted-foreground">{m.reasons_rule()}</span></MoreInfo>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {POSITIONS.map((position) => (
          <div key={position} data-position={position} className="space-y-3">
            <h3 className="font-semibold">{HEADINGS[position]()}</h3>
            {reasons[position].length === 0 ? (!reader && (
              <p className="ui-meta">
                <Link to={`/t/${questionId}?${lang}write=${position}#reply`} className="underline">
                  {m.reasons_write()}
                </Link>
              </p>
            )) : (
              <ul className="space-y-3">
                {reasons[position].map((r) => (
                  <li key={r.id} id={`reason-${r.id}`} className="space-y-2 rounded border p-2">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">
                      <AuthorLink handle={r.authorHandle} name={r.authorName} reader={reader} />{!r.excerpt.translation && r.lang !== readingLang && <>{" "}<span>{m.reading_lang_original({ name: languageLabel(r.lang) })}</span></>}
                    </div>
                    {(r.excerpt.translation || r.excerpt.pending || r.excerpt.unavailable) && (
                      <div className="flex flex-wrap items-center gap-2 ui-meta">
                        {r.excerpt.translation ? (
                          <TranslationLabel
                            fromLang={languageLabel(r.lang)}
                            kind={r.excerpt.translation.kind}
                            engine={r.excerpt.translation.engine}
                            model={r.excerpt.translation.model}
                            fallback={r.excerpt.translation.fallback}
                            stale={r.excerpt.translation.stale}
                            structureMismatch={r.excerpt.translation.structureMismatch}
                          />
                        ) : (
                          <span className="ui-meta text-muted-foreground">{r.excerpt.unavailable ? m.translation_unavailable() : <PendingText />}</span>
                        )}
                      </div>
                    )}
                    <p dir="auto" lang={r.excerpt.lang} className="break-words">
                      {r.excerpt.text}
                    </p>
                    {r.excerpt.truncated && (
                      <p className="ui-meta">
                        <Link to={r.location} aria-label={m.reasons_read_more_aria({ handle: r.authorHandle })} className="underline">
                          {m.reasons_read_more()}
                        </Link>
                      </p>
                    )}
                    <EntryReactions entryId={r.id} reactions={r.reactions} canVote={!reader && !r.own} anchor={`#reason-${r.id}`} loadedAt={loadedAt} reviewHref={r.reviewHref} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
