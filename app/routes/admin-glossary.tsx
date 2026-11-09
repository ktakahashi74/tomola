import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import { Textarea } from "~/components/ui/textarea";
import { useEffect, useRef } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/admin-glossary";
import type { Db } from "~/lib/db/client.server";
import { Pagination } from "~/components/pagination";
import { requireModerator } from "~/lib/auth/session.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { parseGlossaryQuery } from "~/lib/glossary-page.server";
import {
  canEditGlossary,
  clearNeedsReviewBulk,
  countNeedsReview,
  createGlossaryEntry,
  deleteGlossaryEntry,
  editorLabel,
  listGlossary,
  MAX_BULK_IDS,
  needsReviewSummary,
  updateGlossaryEntry,
  type GlossaryActor,
  type GlossaryError,
} from "~/lib/glossary.server";
import { LANGS, LANG_LABELS, type Lang } from "~/lib/languages";
import { parseId } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

// Available to operators and moderators assigned any language (404 for other members). Operators may add, edit, or delete all entries; moderators may change only entries whose target language is assigned to them
// (the server checks per-entry authorization against stored rows: canEditGlossary in app/lib/glossary.server.ts; hiding a form is not authorization).
// Record every change in history with actor, timestamp, and originating proposal post. Deletion retains the entry as deleted rather than removing it.
// This screen retains nine language choices; member-facing /glossary uses enabled languages only. Filters: ?to=, ?from=, ?review=1 for entries needing review; default to all editable entries. Paginate 100 entries at a time.
// Filtered by a target language the person may edit, the page also offers "mark as reviewed" in bulk: the checked rows, every row of the page (?select=all, a link, so it works
// without JavaScript), or every entry of the language that needs review.
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db, scope } = await requireModerator(request);
  const params = new URL(request.url).searchParams;
  const query = parseGlossaryQuery(params, { to: null });
  if (query === null) throw data("Not found", { status: 404 });
  const review = params.get("review") === "1";
  const { entries, hasNext } = await listGlossary(db, { from: query.from ?? undefined, to: query.to ?? undefined, editableBy: scope, needsReview: review, page: query.page });
  const viewer = { userId: user.id, scope };
  // The bulk review is offered for the filtered target language, when this person may edit it (the server checks every entry again).
  const bulk = query.to && canEditGlossary(scope, query.to) ? { lang: query.to, needReview: await countNeedsReview(db, query.to) } : null;
  return {
    query: { from: query.from, to: query.to, page: query.page, review },
    bulk,
    selectAll: bulk !== null && params.get("select") === "all",
    langs: LANGS,
    // Target-language choices for the add form: all nine for operators, assigned languages only for moderators.
    targetLangs: scope.operator ? LANGS : scope.langs,
    page: query.page,
    hasNext,
    entries: entries.map((e) => ({
      id: e.id,
      term: e.term,
      lang: e.lang,
      targetLang: e.targetLang,
      candidates: e.candidates,
      note: e.note,
      keepOriginal: e.keepOriginal,
      needsReview: e.needsReview,
      updatedAt: e.updatedAt.toISOString(),
      lastBy: editorLabel(viewer, { editorHandle: e.updatedByHandle }),
    })),
  };
}

// Preserve filters and pagination after actions through hidden f_to, f_from, f_page fields, validating them again.
function backQuery(form: FormData): string {
  const query = parseGlossaryQuery(new URLSearchParams({ to: formString(form, "f_to"), from: formString(form, "f_from"), page: formString(form, "f_page") || "1" }), { to: null });
  const params = new URLSearchParams();
  if (query?.to) params.set("to", query.to);
  if (query?.from) params.set("from", query.from);
  if (formString(form, "f_review") === "1") params.set("review", "1");
  if (query && query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

// What the bulk "mark as reviewed" answers. The confirmation is a step of its own, rendered by the server (so it works without JavaScript): the first post (no confirm=1)
// only says what would happen; the second (confirm=1) writes.
type BulkAnswer =
  // entries: each selected entry with the updated_at (ms) it had when the page showed it; the confirmation form sends them back as "<id>@<ms>".
  | { step: "confirm"; kind: "selected"; lang: Lang; entries: Array<{ id: number; updatedAt: number }> }
  // fingerprint: of (id, updated_at) of the rows that would be marked; changed: the rows were not the same as when the person was asked before, so they confirm again.
  | { step: "confirm"; kind: "all"; lang: Lang; count: number; latest: string | null; fingerprint: string; changed: boolean }
  | { step: "done"; lang: Lang; changed: number; skipped: number; forbidden: number; stale: number }
  | { step: "none_selected" | "invalid" };

// A selected row travels as "<id>@<updated_at in ms>"; the fingerprint of "all" is 16 hex digits.
const BULK_ROW = /^([1-9]\d{0,15})@(\d{1,16})$/;
const BULK_FINGERPRINT = /^[0-9a-f]{16}$/;

async function confirmAll(db: Db, lang: Lang, changed: boolean): Promise<BulkAnswer> {
  const summary = await needsReviewSummary(db, lang);
  // Nothing needs review any more: there is nothing to confirm.
  if (summary.count === 0) return { step: "done", lang, changed: 0, skipped: 0, forbidden: 0, stale: 0 };
  return { step: "confirm", kind: "all", lang, count: summary.count, latest: summary.latest?.toISOString() ?? null, fingerprint: summary.fingerprint, changed };
}

// "Mark the selected entries as reviewed" (review_selected) and "mark ALL entries of this target language that need review as reviewed" (review_all).
// The route checks that the person may edit the language at all; clearNeedsReviewBulk checks every entry again against its own saved target language, and marks only
// what the person was shown: a selected row changed since, or a set of "all" that is not the confirmed one, is not marked.
async function reviewInBulk(db: Db, actor: GlossaryActor, form: FormData, intent: "review_selected" | "review_all") {
  const bulk = (answer: BulkAnswer, status = 200) => data({ bulk: answer }, { status });
  const lang = LANGS.find((l) => l === formString(form, "targetLang"));
  if (!lang) return bulk({ step: "invalid" }, 400);
  if (!canEditGlossary(actor.scope, lang)) throw data("Forbidden", { status: 403 });
  const confirmed = formString(form, "confirm") === "1";
  let res: Awaited<ReturnType<typeof clearNeedsReviewBulk>>;
  if (intent === "review_selected") {
    const posted = form.getAll("ids").map(String);
    const seen = new Map<number, number>();
    for (const value of posted) {
      const found = BULK_ROW.exec(value);
      if (found && Number.isSafeInteger(Number(found[1])) && Number.isSafeInteger(Number(found[2])) && !seen.has(Number(found[1]))) seen.set(Number(found[1]), Number(found[2]));
    }
    const entries = [...seen].map(([id, updatedAt]) => ({ id, updatedAt }));
    if (entries.length === 0) return bulk({ step: posted.length === 0 ? "none_selected" : "invalid" }, 400);
    if (entries.length > MAX_BULK_IDS) return bulk({ step: "invalid" }, 400);
    if (!confirmed) return bulk({ step: "confirm", kind: "selected", lang, entries });
    res = await clearNeedsReviewBulk(db, actor, { targetLang: lang, entries });
  } else {
    if (!confirmed) return bulk(await confirmAll(db, lang, false));
    // The fingerprint of the rows the person confirmed: if the rows are not the same now, nothing is written and the person confirms what is there now.
    const fingerprint = formString(form, "fingerprint");
    if (!BULK_FINGERPRINT.test(fingerprint)) return bulk({ step: "invalid" }, 400);
    res = await clearNeedsReviewBulk(db, actor, { targetLang: lang, all: { fingerprint } });
  }
  if (!res.ok) return res.error === "rows_changed" ? bulk(await confirmAll(db, lang, true)) : bulk({ step: "invalid" }, 400);
  // Everything that was named is outside the person's rights: a crafted form, not a result.
  if (res.changed === 0 && res.forbidden > 0 && res.stale === 0) throw data("Forbidden", { status: 403 });
  return bulk({ step: "done", lang, changed: res.changed, skipped: res.skipped, forbidden: res.forbidden, stale: res.stale });
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db, scope } = await requireModerator(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  const id = formString(form, "id");
  const actor = { userId: user.id, scope };
  const back = backQuery(form);
  const opts = { proposal: formString(form, "proposal") };
  if (intent === "review_selected" || intent === "review_all") return reviewInBulk(db, actor, form, intent);
  // Return which row was submitted ("new" for additions). Preserve input in uncontrolled fields.
  const failed = (error: GlossaryError, row: string) => {
    if (error === "forbidden") throw data("Forbidden", { status: 403 });
    return data({ error, row }, { status: 400 });
  };
  if (intent === "delete") {
    const res = await deleteGlossaryEntry(db, actor, parseId(id), opts);
    // Return to the list if an entry no longer exists because someone else deleted it first.
    if (res.ok || res.error === "not_found") throw redirect(`/admin/glossary${back}`);
    return failed(res.error, id);
  }
  const input = {
    term: formString(form, "term"),
    candidates: formString(form, "candidates"),
    note: formString(form, "note"),
    keepOriginal: form.get("keepOriginal") === "on",
    needsReview: form.get("needsReview") === "on",
  };
  if (intent === "update") {
    // Term and target languages are immutable and absent from the form; the server returns lang_fixed for tampered submissions.
    const res = await updateGlossaryEntry(db, actor, parseId(id), { ...input, lang: form.get("lang"), targetLang: form.get("targetLang") }, opts);
    if (res.ok && res.changed) throw redirect(`/admin/glossary${back}#g-${id}`);
    // Nothing changed: no history entry was made and the proposal post that was named is not recorded. Say so on the row instead of looking like a success.
    if (res.ok) return data({ notice: "unchanged" as const, row: id });
    if (res.error === "not_found") throw redirect(`/admin/glossary${back}`);
    return failed(res.error, id);
  }
  const res = await createGlossaryEntry(db, actor, { ...input, lang: formString(form, "lang"), targetLang: formString(form, "targetLang") }, opts);
  if (res.ok) throw redirect(`/admin/glossary${back}#g-${res.id}`);
  return failed(res.error, "new");
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.admin_glossary_title() }];
}

function errorMessage(error: GlossaryError): string {
  if (error === "duplicate") return m.glossary_error_duplicate();
  if (error === "invalid_term") return m.glossary_error_term();
  if (error === "invalid_lang" || error === "invalid_target" || error === "same_lang") return m.glossary_error_lang();
  if (error === "lang_fixed") return m.glossary_error_lang_fixed();
  if (error === "invalid_proposal") return m.glossary_error_proposal();
  if (error === "forbidden") return m.glossary_error_forbidden();
  return m.glossary_error_generic();
}

function LangSelect({ name, defaultValue, label, options }: { name: string; defaultValue: string; label: string; options: readonly Lang[] }) {
  return (
    <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
      {label}
      <Select name={name} defaultValue={defaultValue} items={[...options.map((l) => (
          { value: l, label: LANG_LABELS[l] }
        ))]}>
              <SelectTrigger className="w-full min-w-0" aria-label={label}><SelectValue /></SelectTrigger>
              <SelectContent>
        {options.map((l) => (
          <SelectItem key={l} value={l}>
            {LANG_LABELS[l]}
          </SelectItem>
        ))}
      </SelectContent>
            </Select>
    </FieldLabel></Field>
  );
}

type Entry = Route.ComponentProps["loaderData"]["entries"][number];
type Back = { to: Lang | null; from: Lang | null; page: number; review: boolean };

// Hidden fields preserving filters and pagination after actions.
function BackFields({ back }: { back: Back }) {
  return (
    <>
      <input type="hidden" name="f_to" value={back.to ?? ""} />
      <input type="hidden" name="f_from" value={back.from ?? ""} />
      <input type="hidden" name="f_review" value={back.review ? "1" : ""} />
      <input type="hidden" name="f_page" value={back.page} />
    </>
  );
}

// The address of the list with the filters and the page of the current view (plus what a link adds).
function listHref(back: Back, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (back.to) params.set("to", back.to);
  if (back.from) params.set("from", back.from);
  if (back.review) params.set("review", "1");
  if (back.page > 1) params.set("page", String(back.page));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return `/admin/glossary${text ? `?${text}` : ""}`;
}

type Bulk = NonNullable<Route.ComponentProps["loaderData"]["bulk"]>;
type BulkAnswerData = Extract<NonNullable<Route.ComponentProps["actionData"]>, { bulk: unknown }>["bulk"];

// The bulk "mark as reviewed": what it does, the two actions, and the answer of the last post (the confirmation, the result or the refusal). The checkboxes of the rows
// belong to the form "bulk-review" through their form attribute (forms do not nest), so the rows keep their own forms.
// The three forms post to the list without ?select=all, so that the next rows do not come back pre-checked after a post.
function BulkReview({ bulk, back, answer, entries, selectAll, hasSelectable }: { bulk: Bulk; back: Back; answer?: BulkAnswerData; entries: Entry[]; selectAll: boolean; hasSelectable: boolean }) {
  const lang = LANG_LABELS[bulk.lang];
  const action = listHref(back);
  // Buttons are off while a post is on its way (a second click would send the same question twice).
  const busy = useNavigation().state !== "idle";
  // The confirmation takes the focus when it appears (with scripts; without them the page is new and the question is at the top).
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (answer?.step === "confirm") confirmRef.current?.focus();
  }, [answer]);
  const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  return (
    <section aria-labelledby="bulk-review-heading" className="space-y-3 rounded border border-notice-strong p-3">
      <h2 id="bulk-review-heading" className="text-lg font-semibold">
        {m.glossary_bulk_heading()}
      </h2>
      <p className="ui-help">{m.glossary_bulk_intro({ lang })}</p>
      {answer?.step === "done" && (
        <div role="status" className="space-y-1 ui-help">
          <p className="font-semibold">
            {m.glossary_bulk_done({ changed: answer.changed, lang: LANG_LABELS[answer.lang] })}
          </p>
          {answer.stale > 0 && <p className="font-semibold">{m.glossary_bulk_stale({ stale: answer.stale })}</p>}
          {answer.skipped > 0 && <p>{m.glossary_bulk_skipped({ skipped: answer.skipped })}</p>}
          {answer.forbidden > 0 && <p>{m.glossary_bulk_forbidden({ forbidden: answer.forbidden })}</p>}
        </div>
      )}
      {(answer?.step === "none_selected" || answer?.step === "invalid") && (
        <p role="alert" className="text-destructive">
          {answer.step === "none_selected" ? m.glossary_bulk_none_selected() : m.glossary_error_generic()}
        </p>
      )}
      {answer?.step === "confirm" && (
        <div ref={confirmRef} tabIndex={-1} role="group" aria-labelledby="bulk-confirm-text" className="space-y-2 rounded border-2 border-foreground p-3">
          {answer.kind === "all" ? (
            <>
              {answer.changed && <p>{m.glossary_bulk_count_changed({ count: answer.count })}</p>}
              <p id="bulk-confirm-text" role="alert" className="font-semibold">
                {m.glossary_bulk_confirm_all({ count: answer.count, lang: LANG_LABELS[answer.lang] })}
              </p>
              {answer.latest && <p className="ui-meta">{m.glossary_bulk_latest({ when: when(answer.latest) })}</p>}
            </>
          ) : (
            <>
              <p id="bulk-confirm-text" role="alert" className="font-semibold">
                {m.glossary_bulk_confirm_selected({ count: answer.entries.length, lang: LANG_LABELS[answer.lang] })}
              </p>
              <ul className="list-inside list-disc text-sm">
                {entries
                  .filter((e) => answer.entries.some((picked) => picked.id === e.id))
                  .map((e) => (
                    <li key={e.id}>
                      <span lang={e.lang}>{e.term}</span> ({m.glossary_pair({ from: LANG_LABELS[e.lang], to: LANG_LABELS[e.targetLang] })})
                    </li>
                  ))}
              </ul>
            </>
          )}
          <Form method="post" action={action} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="targetLang" value={answer.lang} />
            <input type="hidden" name="confirm" value="1" />
            {answer.kind === "all" ? (
              <input type="hidden" name="fingerprint" value={answer.fingerprint} />
            ) : (
              answer.entries.map((picked) => <input key={picked.id} type="hidden" name="ids" value={`${picked.id}@${picked.updatedAt}`} />)
            )}
            <Button type="submit" name="intent" value={answer.kind === "all" ? "review_all" : "review_selected"} disabled={busy} className="disabled:opacity-50">
              {m.glossary_bulk_confirm_yes()}
            </Button>
            <Link to={action} className="underline">
              {m.cancel()}
            </Link>
          </Form>
        </div>
      )}
      <p className="ui-meta">{m.glossary_bulk_count({ count: bulk.needReview, lang })}</p>
      {hasSelectable && (
        <p className="ui-meta">
          {selectAll ? (
            <Link to={action} className="underline">
              {m.glossary_bulk_clear_selection()}
            </Link>
          ) : (
            <Link to={listHref(back, { select: "all" })} className="underline">
              {m.glossary_bulk_select_all()}
            </Link>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {hasSelectable && (
          <Form method="post" action={action} id="bulk-review">
            <input type="hidden" name="targetLang" value={bulk.lang} />
            <Button type="submit" name="intent" value="review_selected" disabled={busy} className="disabled:opacity-50" variant="outline">
              {m.glossary_bulk_selected_button()}
            </Button>
          </Form>
        )}
        {bulk.needReview > 0 && (
          <Form method="post" action={action}>
            <input type="hidden" name="targetLang" value={bulk.lang} />
            <Button type="submit" name="intent" value="review_all" disabled={busy} className="disabled:opacity-50" variant="outline">
              {m.glossary_bulk_all_button({ count: bulk.needReview, lang })}
            </Button>
          </Form>
        )}
      </div>
    </section>
  );
}

function GlossaryForm({
  entry,
  error,
  notice,
  back,
  langs,
  targetLangs,
}: {
  entry?: Entry;
  error?: GlossaryError;
  notice?: "unchanged";
  back: Back;
  langs: readonly Lang[];
  targetLangs: readonly Lang[];
}) {
  // Add-form defaults: target language is the filter's target, or the first available language. Term language is the source filter, or the first language different from the target.
  const target = back.to && targetLangs.includes(back.to) ? back.to : targetLangs[0];
  const source = back.from && back.from !== target ? back.from : (langs.find((l) => l !== target) ?? langs[0]);
  return (
    <Form method="post" id={entry ? `g-${entry.id}` : undefined} className="space-y-2 rounded border p-3">
      {entry && <input type="hidden" name="id" value={entry.id} />}
      <BackFields back={back} />
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
          {m.glossary_term()}
          <Input type="text" name="term" required maxLength={200} defaultValue={entry?.term ?? ""} lang={entry?.lang} className="block" />
        </FieldLabel></Field>
        {entry ? (
          // Immutable after creation: display text rather than a selector.
          <p className="ui-meta">
            {m.glossary_pair({ from: LANG_LABELS[entry.lang], to: LANG_LABELS[entry.targetLang] })}
          </p>
        ) : (
          <>
            <LangSelect name="lang" defaultValue={source} label={m.glossary_lang()} options={langs} />
            <LangSelect name="targetLang" defaultValue={target} label={m.glossary_target()} options={targetLangs} />
          </>
        )}
        <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 text-sm">
          <Checkbox name="keepOriginal" defaultChecked={entry?.keepOriginal ?? false} />
          {m.glossary_keep()}
        </FieldLabel></Field>
        <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 text-sm">
          <Checkbox name="needsReview" defaultChecked={entry?.needsReview ?? false} />
          {m.glossary_needs_review()}
        </FieldLabel></Field>
      </div>
      <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
        {m.glossary_candidates()}
        <Textarea name="candidates" rows={2} lang={entry?.targetLang} defaultValue={entry?.candidates.join("\n") ?? ""} className="block w-full" />
      </FieldLabel></Field>
      <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
        {m.glossary_note()}
        <Input type="text" name="note" maxLength={500} defaultValue={entry?.note ?? ""} className="block w-full" />
      </FieldLabel></Field>
      <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
        {m.glossary_proposal_field()}
        <Input type="text" name="proposal" maxLength={300} className="block w-full" />
      </FieldLabel></Field>
      {entry && <p className="ui-meta text-muted-foreground">{entry.lastBy ? m.glossary_last_edited({ who: entry.lastBy, date: entry.updatedAt.slice(0, 10) }) : m.glossary_last_edited({ who: m.glossary_editor_unknown(), date: entry.updatedAt.slice(0, 10) })}</p>}
      {error && <p className="text-destructive">{errorMessage(error)}</p>}
      {notice === "unchanged" && (
        <p role="status" className="ui-help text-notice-foreground">
          {m.glossary_notice_unchanged()}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" name="intent" value={entry ? "update" : "create"}>
          {entry ? m.glossary_save() : m.glossary_add()}
        </Button>
        {entry && (
          <Button type="submit" name="intent" value="delete" formNoValidate onClick={(e) => {
              if (!window.confirm(m.glossary_delete_confirm())) e.preventDefault();
            }} variant="destructive">
            {m.glossary_delete()}
          </Button>
        )}
      </div>
    </Form>
  );
}

export default function AdminGlossary({ loaderData, actionData }: Route.ComponentProps) {
  const { entries, query, langs, targetLangs, page, hasNext, bulk, selectAll } = loaderData;
  // What the last form post answered for a row ("new" is the add form): an error, or the notice that nothing changed.
  const errorOf = (row: string) => (actionData && "error" in actionData && actionData.row === row ? actionData.error : undefined);
  const noticeOf = (row: string) => (actionData && "notice" in actionData && actionData.row === row ? actionData.notice : undefined);
  const bulkAnswer = actionData && "bulk" in actionData ? actionData.bulk : undefined;
  const selectable = bulk ? entries.filter((e) => e.needsReview) : [];
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold">{m.admin_glossary_title()}</h1>
      <p className="ui-help text-muted-foreground">{m.admin_glossary_intro()}</p>
      <p className="ui-meta">
        <Link to="/glossary" className="underline">
          {m.glossary_public_link()}
        </Link>
      </p>
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
          <Select name="to" defaultValue={query.to ?? ""} items={[{ value: "", label: m.glossary_filter_all() }, ...langs.map((l) => (
              { value: l, label: LANG_LABELS[l] }
            ))]}>
              <SelectTrigger className="w-full min-w-0" aria-label={m.glossary_target()}><SelectValue /></SelectTrigger>
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
        <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 pb-1 text-sm">
          <Checkbox name="review" value="1" defaultChecked={query.review} />
          {m.glossary_filter_review()}
        </FieldLabel></Field>
        <Button type="submit" variant="outline">
          {m.glossary_filter_apply()}
        </Button>
      </Form>
      {bulk ? (
        <BulkReview bulk={bulk} back={query} answer={bulkAnswer} entries={entries} selectAll={selectAll} hasSelectable={selectable.length > 0} />
      ) : (
        <p className="ui-help text-muted-foreground">{m.glossary_bulk_need_language()}</p>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.glossary_add()}</h2>
        <p className="ui-help text-muted-foreground">{m.glossary_fixed_note()}</p>
        <GlossaryForm back={query} langs={langs} targetLangs={targetLangs} error={errorOf("new")} />
      </section>
      <section className="space-y-3">
        {entries.length === 0 && <p>{m.glossary_empty()}</p>}
        {entries.map((e) => (
          <div key={`${e.id}:${e.updatedAt}`} className="space-y-1">
            {bulk && e.needsReview && (
              <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-1 text-sm">
                {/* The value carries the updated_at that this page shows: a row changed after that is not marked (the server compares). Only this box is keyed by selectAll
                    (to take the new default); the row form below keeps what has been typed into it. */}
                <Checkbox key={String(selectAll)} name="ids" value={`${e.id}@${Date.parse(e.updatedAt)}`} form="bulk-review" defaultChecked={selectAll} />
                {m.glossary_bulk_select_row({ term: e.term, pair: m.glossary_pair({ from: LANG_LABELS[e.lang], to: LANG_LABELS[e.targetLang] }) })}
              </FieldLabel></Field>
            )}
            <GlossaryForm entry={e} back={query} langs={langs} targetLangs={targetLangs} error={errorOf(String(e.id))} notice={noticeOf(String(e.id))} />
          </div>
        ))}
      </section>
      <Pagination page={page} hasNext={hasNext} dropParams={["select"]} />
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
