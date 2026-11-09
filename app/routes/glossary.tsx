import { Field, FieldLabel } from "~/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { data, Form, Link } from "react-router";
import type { Route } from "./+types/glossary";
import { MoreInfo } from "~/components/ui/more-info";
import { OpenInAi } from "~/components/open-in-ai";
import { Pagination } from "~/components/pagination";
import { requireMember } from "~/lib/auth/session.server";
import { resolveDisplayLang } from "~/lib/display";
import { HISTORY_SHOWN, isReviewMark, type GlossaryChangeKind, type GlossaryContent } from "~/lib/glossary";
import { OBJECTION_PATH, loadGlossaryPage, parseGlossaryQuery, PRINCIPLES_PAGE_READY } from "~/lib/glossary-page.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { getViewer, isModerator } from "~/lib/roles.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

// Glossary readable by every member, including suspended members: entries, latest editor, and change history (who, when, and based on which proposal).
// Recommended translations, not requirements. Changes affect future translations and report-triggered retries only. Operators or moderators assigned the target language decide acceptance, independent of stance counts.
// Editing: /admin/glossary for operators and target-language moderators. Proposals are question topics (/t/new?propose_term=1…); no dedicated columns or review screen.

export function headers() {
  return { "Cache-Control": "private" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: m.glossary_title() },
    ...(loaderData ? [{ tagName: "link" as const, rel: "alternate", type: "text/markdown", href: loaderData.alternate }] : []),
  ];
}

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

export async function loader({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  // Default target language: viewer's display language; source: all languages, without privileging English. ?lang= overrides this page's display language only, not filtering.
  // The filters offer the enabled languages only (ENABLED_LANGS); a ?to= or ?from= of another language falls back to the default.
  const enabled = enabledLangs();
  const query = parseGlossaryQuery(new URL(request.url).searchParams, { to: resolveDisplayLang({ query: null, profile, uiLocale: getLocale(), enabled }) }, enabled);
  if (query === null) throw data("Not found", { status: 404 });
  const viewer = await getViewer(db, user);
  // The newest changes of each entry; ?history=all shows every change.
  const historyAll = new URL(request.url).searchParams.get("history") === "all";
  const { items, hasNext } = await loadGlossaryPage(db, viewer, query, { historyLimit: historyAll ? undefined : HISTORY_SHOWN });
  const filters: Record<string, string> = {};
  if (query.to) filters.to = query.to;
  if (query.from) filters.from = query.from;
  if (query.deleted) filters.deleted = "1";
  const mdQuery = new URLSearchParams(filters);
  if (query.page > 1) mdQuery.set("page", String(query.page));
  return {
    query,
    langs: enabled,
    // Operators or moderators assigned any language can enter /admin/glossary, including to add entries when none exist yet.
    canEditAny: isModerator(viewer.scope),
    // How to appeal acceptance decisions: rules and appeals pages. Omit links if those pages do not exist yet.
    objectionPath: PRINCIPLES_PAGE_READY ? OBJECTION_PATH : null,
    alternate: `/glossary.md${mdQuery.size > 0 ? `?${mdQuery}` : ""}`,
    aiOpen: aiOpenLinks(request, profile, "/glossary", { extra: filters }),
    page: query.page,
    hasNext,
    items: items.map((e) => ({
      id: e.id,
      term: e.term,
      lang: e.lang,
      targetLang: e.targetLang,
      candidates: e.candidates,
      note: e.note,
      keepOriginal: e.keepOriginal,
      needsReview: e.needsReview,
      deleted: e.deleted,
      lastBy: e.lastBy,
      lastAt: dateOf(e.lastAt),
      canEdit: e.canEdit,
      historyTotal: e.historyTotal,
      history: e.history.map((h) => ({ id: h.id, kind: h.kind, at: dateOf(h.at), by: h.by, before: h.before, after: h.after, proposalId: h.proposalId })),
    })),
  };
}

const KIND_LABEL: Record<GlossaryChangeKind, () => string> = {
  created: () => m.glossary_change_created(),
  updated: () => m.glossary_change_updated(),
  deleted: () => m.glossary_change_deleted(),
};

// Before/after history content, displayed side by side without diff highlighting.
function Content({ content, lang, targetLang }: { content: GlossaryContent; lang: Lang; targetLang: Lang }) {
  return (
    <p className="text-sm">
      <span lang={lang}>{content.term}</span> →{" "}
      {content.candidates.length > 0 ? <span lang={targetLang}>{content.candidates.join("、")}</span> : m.glossary_no_candidates()}
      {content.note !== "" && <span> · {content.note}</span>}
      {content.keepOriginal && <span> · {m.glossary_keep()}</span>}
      {content.needsReview && <span> · {m.glossary_needs_review_badge()}</span>}
    </p>
  );
}

function proposeUrl(params: Record<string, string>): string {
  return `/t/new?${new URLSearchParams({ asks_stance: "1", propose_term: "1", ...params })}`;
}

export default function Glossary({ loaderData }: Route.ComponentProps) {
  const { query, langs, canEditAny, objectionPath, aiOpen, items, page, hasNext } = loaderData;
  const newTerm = proposeUrl({ ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) });
  return (
    <main className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{m.glossary_title()}</h1>
        <OpenInAi mdUrl={aiOpen.mdUrl} mdPath={aiOpen.mdPath} />
      </div>
      {/* The one sentence a reader needs first; how the list is used and who decides what is in it is one fold behind it. */}
      <div className="ui-help text-muted-foreground">
        {m.glossary_intro()}{" "}
        <MoreInfo label={m.glossary_scope_label()}>
          {m.glossary_scope_note()}{" "}
          {m.glossary_decide_note()}
          {objectionPath && (
            <>
              {" "}
              <Link to={objectionPath} className="underline">
                {m.glossary_objection_link()}
              </Link>
            </>
          )}
        </MoreInfo>
      </div>
      <Form method="get" role="search" className="flex flex-wrap items-end gap-3">
        <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
          {m.glossary_lang()}
          <Select name="from" defaultValue={query.from ?? ""} items={[{ value: "", label: m.glossary_filter_all() }, ...langs.map((l) => (
              { value: l, label: LANG_LABELS[l] }
            ))]}>
              <SelectTrigger className="w-full min-w-0" aria-label={m.glossary_lang()}><SelectValue /></SelectTrigger>
              <SelectContent>
            <SelectItem value="">{m.glossary_filter_all()}</SelectItem>
            {langs.map((l) => (
              <SelectItem key={l} value={l}>
                {LANG_LABELS[l]}
              </SelectItem>
            ))}
          </SelectContent>
            </Select>
        </FieldLabel></Field>
        <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
          {m.glossary_target()}
          <Select name="to" defaultValue={query.to ?? ""} items={[...langs.map((l) => (
              { value: l, label: LANG_LABELS[l] }
            ))]}>
              <SelectTrigger className="w-full min-w-0" aria-label={m.glossary_target()}><SelectValue /></SelectTrigger>
              <SelectContent>
            {langs.map((l) => (
              <SelectItem key={l} value={l}>
                {LANG_LABELS[l]}
              </SelectItem>
            ))}
          </SelectContent>
            </Select>
        </FieldLabel></Field>
        {query.deleted && <input type="hidden" name="deleted" value="1" />}
        <Button type="submit" variant="outline">
          {m.glossary_filter_apply()}
        </Button>
      </Form>
      <div className="flex flex-wrap items-center gap-4 ui-meta">
        <Link to={newTerm} className="underline">
          {m.glossary_propose_new()}
        </Link>
        <a href="/glossary.yaml" download className="underline">
          {m.glossary_download()}
        </a>
        {canEditAny && (
          <Link to="/admin/glossary" className="underline">
            {m.glossary_edit_all()}
          </Link>
        )}
        <Link to={`/glossary?${new URLSearchParams({ ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), ...(query.deleted ? {} : { deleted: "1" }) })}`} className="underline">
          {query.deleted ? m.glossary_show_current() : m.glossary_show_deleted()}
        </Link>
      </div>
      {query.deleted && <h2 className="text-lg font-semibold">{m.glossary_deleted_heading()}</h2>}
      {items.length === 0 && <p>{m.glossary_no_match()}</p>}
      <ul className="space-y-3">
        {items.map((e) => (
          <li key={e.id} id={`g-${e.id}`} className="space-y-1 rounded border p-3">
            <p>
              <span lang={e.lang} className="font-semibold">
                {e.term}
              </span>{" "}
              <span className="ui-meta text-muted-foreground">{m.glossary_pair({ from: LANG_LABELS[e.lang], to: LANG_LABELS[e.targetLang] })}</span>
            </p>
            {!e.deleted && (
              <p>
                {e.candidates.length > 0 ? <span lang={e.targetLang}>{e.candidates.join("、")}</span> : <span className="text-muted-foreground">{m.glossary_no_candidates()}</span>}
              </p>
            )}
            {!e.deleted && (e.keepOriginal || e.needsReview) && (
              <p className="flex flex-wrap gap-2 ui-meta">
                {e.keepOriginal && <span className="rounded border px-1">{m.glossary_keep()}</span>}
                {e.needsReview && <span className="rounded border border-notice-strong px-1 text-notice-foreground">{m.glossary_needs_review_badge()}</span>}
              </p>
            )}
            {!e.deleted && e.note !== "" && <p className="text-sm">{e.note}</p>}
            <p className="ui-meta text-muted-foreground">
              {(e.deleted ? m.glossary_deleted_at : m.glossary_last_edited)({ who: e.lastBy ?? m.glossary_editor_unknown(), date: e.lastAt })}
            </p>
            <details>
              <summary className="cursor-pointer ui-meta">{m.glossary_history({ count: e.historyTotal })}</summary>
              <ol className="mt-2 space-y-2">
                {e.history.map((h) => (
                  <li key={h.id} className="space-y-1 border-l-2 ps-3">
                    <p className="ui-meta">
                      {h.at} · {h.by ?? m.glossary_editor_unknown()} · {h.kind === "updated" && isReviewMark(h.before, h.after) ? m.glossary_change_reviewed() : KIND_LABEL[h.kind]()}
                      {h.proposalId !== null && (
                        <>
                          {" · "}
                          <Link to={`/t/${h.proposalId}`} className="underline">
                            {m.glossary_proposal_link({ id: h.proposalId })}
                          </Link>
                        </>
                      )}
                    </p>
                    {h.before && (
                      <div>
                        <span className="ui-meta text-muted-foreground">{m.glossary_before()}</span>
                        <Content content={h.before} lang={e.lang} targetLang={e.targetLang} />
                      </div>
                    )}
                    {h.after && (
                      <div>
                        <span className="ui-meta text-muted-foreground">{m.glossary_after()}</span>
                        <Content content={h.after} lang={e.lang} targetLang={e.targetLang} />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {e.historyTotal > e.history.length && (
                <p className="mt-2 ui-meta">
                  <Link to={`/glossary?${new URLSearchParams({ ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), ...(query.deleted ? { deleted: "1" } : {}), ...(page > 1 ? { page: String(page) } : {}), history: "all" })}#g-${e.id}`} className="underline">
                    {m.glossary_history_all({ count: e.historyTotal })}
                  </Link>
                </p>
              )}
            </details>
            <p className="flex flex-wrap gap-4 ui-meta">
              {e.deleted ? (
                <Link to={proposeUrl({ from: e.lang, to: e.targetLang })} className="underline">
                  {m.glossary_propose_term()}
                </Link>
              ) : (
                <Link to={proposeUrl({ entry: String(e.id) })} className="underline">
                  {m.glossary_propose_entry()}
                </Link>
              )}
              {e.canEdit && !e.deleted && (
                <Link to={`/admin/glossary?${new URLSearchParams({ to: e.targetLang, from: e.lang })}#g-${e.id}`} className="underline">
                  {m.glossary_edit_link()}
                </Link>
              )}
            </p>
          </li>
        ))}
      </ul>
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}
