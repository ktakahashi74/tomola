import { Link } from "react-router";
import { PendingText } from "~/components/pending-text";
import { ActionPanel } from "~/components/ui/action-panel";
import { TranslationLabel } from "~/components/translation-label";
import { AuthorLink } from "~/components/author-link";
import type { AltItem, ObjectionItem, ObjectionPanel } from "~/lib/objections.server";
import { languageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";

// Alternative questions and objection replies, shared by the panel and the full-list page. Neither list receives rankings or badges.
export function AlternativeList({ items, langParam, reader = false }: { items: AltItem[]; langParam: string | null; reader?: boolean }) {
  if (items.length === 0) return <p className="ui-help text-muted-foreground">{m.objections_none()}</p>;
  const lang = langParam ? `?lang=${langParam}` : "";
  return (
    <ul className="space-y-1">
      {items.map((a) => (
        <li key={a.id}>
          <Link to={`/t/${a.id}${lang}`} dir="auto" lang={a.title.lang} className="link-ui">
            {a.title.text}
          </Link>{" "}
          <span className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">
            <AuthorLink handle={a.authorHandle} name={a.authorName} reader={reader} />{" "}<span>{languageLabel(a.lang)}</span>
          </span>
          {a.title.kind && <TranslationLabel kind={a.title.kind} engine={a.title.engine} fallback={a.title.fallback} stale={a.title.stale} structureMismatch={a.title.structureMismatch} />}
          {a.title.pending && <span className="ui-meta"> <PendingText short /></span>}
        </li>
      ))}
    </ul>
  );
}

export function ObjectionList({ items, reader = false }: { items: ObjectionItem[]; reader?: boolean }) {
  if (items.length === 0) return <p className="ui-help text-muted-foreground">{m.objections_none()}</p>;
  return (
    <ul className="space-y-1">
      {items.map((o) => (
        <li key={o.id}>
          <Link to={o.location} dir="auto" lang={o.lang} className="link-ui">
            {o.excerpt}
          </Link>{" "}
          <span className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">
            <AuthorLink handle={o.authorHandle} name={o.authorName} reader={reader} />{" "}<span>{languageLabel(o.lang)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// The question page's "問いの立て方への異議" panel is always present. Simply list alternative framings and replies tagged objection; neither is endorsed as correct or given rankings or badges.
// Entry points: write an objection reply, ask the question another way, or view all (/t/:id/objections).
export function ObjectionsPanel({ questionId, panel, langParam, reader = false }: { questionId: number; panel: ObjectionPanel; langParam: string | null; reader?: boolean }) {
  const lang = langParam ? `?lang=${langParam}` : "";
  if (panel.alternatives.length === 0 && panel.objections.length === 0) {
    return (
      <section id="objections" className="border-t pt-4" aria-label={m.objections_title()}>
        <ActionPanel label={m.objections_title()} summaryClassName="h-auto px-1 font-semibold text-foreground">
          <div className="space-y-3">
            <p className="ui-help text-muted-foreground">{m.objections_help()}</p>
            {!reader && (
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
                <Link to={`/t/${questionId}?write=objection#reply`} className="underline">{m.objections_write()}</Link>
                <Link to={`/t/new?asks_stance=1&alt_of=${questionId}`} className="underline">{m.objections_new_alt()}</Link>
              </p>
            )}
          </div>
        </ActionPanel>
      </section>
    );
  }
  return (
    <section id="objections" className="space-y-3 border-t pt-4" aria-labelledby="objections-heading">
      <h2 id="objections-heading" className="text-lg font-semibold">
        {m.objections_title()}
      </h2>
      <p className="ui-help text-muted-foreground">{m.objections_neutrality()}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <h3 className="font-semibold">{m.objections_alternatives()}</h3>
          <AlternativeList items={panel.alternatives} langParam={langParam} reader={reader} />
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold">{m.objections_replies()}</h3>
          <ObjectionList items={panel.objections} reader={reader} />
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
        <Link to={`/t/${questionId}/objections${lang}`} className="underline">
          {m.objections_see_all()}
        </Link>
        {!reader && <><Link to={`/t/${questionId}?write=objection#reply`} className="underline">
          {m.objections_write()}
        </Link>
        <Link to={`/t/new?asks_stance=1&alt_of=${questionId}`} className="underline">
          {m.objections_new_alt()}
        </Link></>}
      </p>
    </section>
  );
}
