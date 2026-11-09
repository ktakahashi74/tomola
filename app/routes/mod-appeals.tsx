import { DisplayNameEvidence } from "~/components/display-name-evidence";
import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { PersistentDetails } from "~/components/persistent-details";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/mod-appeals";
import { appealActionText } from "~/components/appeal-action";
import { VillageAppealDetails } from "~/components/village-moderation";
import { FixBeforeNow } from "~/components/fix-before-now";
import { Pagination } from "~/components/pagination";
import { reasonLabel } from "~/components/reason-label";
import { decideAppeal, listOpenAppeals, MAX_DECISION_NOTE, type DecideError } from "~/lib/appeals.server";
import { requireModerator } from "~/lib/auth/session.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { LANG_LABELS } from "~/lib/languages";
import { parseId, parsePage } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

// Appeal review for moderators and operators, regardless of assigned language. Hide an appeal from both the action's actor and the appellant.
// Uphold or overturn the action. Overturning automatically restores hidden/deleted posts, suspension, or stance/「なるほど」 exclusions. Notify the appellant of the outcome.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.mod_appeals_title() }];
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db, scope } = await requireModerator(request);
  await enforceMemberLimit(db, "mod-appeals", user.id);
  const result = await listOpenAppeals(db, { id: user.id, scope }, { page: parsePage(request) });
  // Review outcome display (done): upheld, overturned (action reversed), overturned-nochange (overturned but nothing remained to restore).
  const done = new URL(request.url).searchParams.get("done");
  return {
    done: done === "upheld" || done === "overturned" || done === "overturned-nochange" ? done : null,
    page: result.page,
    hasNext: result.hasNext,
    maxLength: MAX_DECISION_NOTE,
    cards: result.cards.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString().slice(0, 10),
      actionDate: c.actionDate.toISOString().slice(0, 10),
      until: c.until ? c.until.toISOString().slice(0, 10) : null,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  // Reject changes from cross-site POSTs (CSRF), checking before authentication or input parsing (csrf.server.ts convention).
  assertSameOrigin(request);
  const { user, db, scope } = await requireModerator(request);
  await enforceMemberLimit(db, "mod-appeals", user.id);
  const form = await request.formData();
  const appealId = parseId(formString(form, "appealId"));
  const decision = formString(form, "intent") === "overturn" ? "overturned" : formString(form, "intent") === "uphold" ? "upheld" : null;
  if (decision === null) throw data("Bad request", { status: 400 });
  let res;
  try { res = await decideAppeal(db, { id: user.id, scope }, appealId, { decision, note: formString(form, "note") }); }
  catch (error) {
    if (!(error instanceof MarkdownBusyError)) throw error;
    return data({ error: "rate_limited" as const, appealId, note: formString(form, "note") }, { status: 503, headers: { "Retry-After": "1" } });
  }
  if (res.ok) throw redirect(`/mod/appeals?done=${res.status === "upheld" ? "upheld" : res.reversed ? "overturned" : "overturned-nochange"}`);
  if (res.error === "not_found") throw data("Not found", { status: 404 });
  return data({ error: res.error, appealId }, { status: res.error === "forbidden" || res.error === "own_action" || res.error === "own_appeal" || res.error === "reporter" ? 403 : 400 });
}

function errorText(error: DecideError | "rate_limited"): string {
  switch (error) {
    case "rate_limited":
      return m.error_rate_limited();
    case "own_action":
      return m.mod_appeals_error_own_action();
    case "own_appeal":
      return m.mod_appeals_error_own_appeal();
    case "reporter":
      return m.mod_appeals_error_reporter();
    case "already_decided":
      return m.mod_appeals_error_decided();
    case "note_required":
    case "invalid_note":
      return m.mod_appeals_error_note();
    default:
      return m.mod_error_forbidden();
  }
}

export default function ModAppeals({ loaderData, actionData }: Route.ComponentProps) {
  const { cards, page, hasNext, maxLength, done } = loaderData;
  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-bold">{m.mod_appeals_title()}</h1>
        <Link to="/mod" className="underline">
          {m.mod_title()}
        </Link>
      </div>
      <p className="ui-help text-muted-foreground">{m.mod_appeals_intro()}</p>
      {done && (
        <p role="status" className="text-success">
          {done === "upheld" ? m.mod_appeals_done_upheld() : done === "overturned" ? m.mod_appeals_done_overturned() : m.mod_appeals_done_nochange()}
        </p>
      )}
      {actionData?.error && (
        <p role="alert" className="text-destructive">
          {errorText(actionData.error)}
        </p>
      )}
      {cards.length === 0 && <p>{m.mod_appeals_empty()}</p>}
      {cards.map((c) => (
        <section key={c.id} id={`a-${c.id}`} className="space-y-3 rounded border p-4">
          <div className="ui-meta text-muted-foreground">
            {c.chat ? m.mod_kind_chat() : m.mod_appeals_meta({ handle: c.appellantHandle, date: c.createdAt })}
          </div>
          <div className="space-y-1 text-sm">
            <p className="font-semibold">{appealActionText(c.action, c.until)}</p>
            <p className="ui-meta">{m.appeal_date({ date: c.actionDate })}</p>
            <p className="ui-meta">{m.notification_reason({ reason: reasonLabel(c.reason) })}</p>
            {c.note && <p>{m.notification_note({ note: c.note })}</p>}
          </div>
          {c.village !== undefined && <VillageAppealDetails village={c.village} before={c.villageBefore ?? null} />}
          {c.avatarUrl && <img src={c.avatarUrl} alt="" width="64" height="64" className="rounded" />}
          {c.displayNames && <DisplayNameEvidence names={c.displayNames} />}
          {c.action === "end_village" && <p className="ui-help">{m.village_appeal_end_help()}</p>}
          {c.entry && (
            <PersistentDetails open className="text-sm">
              <summary className="cursor-pointer ui-meta">
                {m.appeal_entry()} · <span lang={c.entry.lang}>{LANG_LABELS[c.entry.lang]}</span>
                {c.entry.deleted && <> · {m.entry_deleted_placeholder()}</>}
                {c.entry.hidden && <> · {m.entry_hidden_mark_short()}</>}
              </summary>
              {c.action === "fix_entry" ? (
                <FixBeforeNow before={c.before} now={{ title: c.entry.title, body: c.entry.body }} lang={c.entry.lang} />
              ) : (
                <>
                  {c.entry.title && (
                    <p lang={c.entry.lang} className="mt-2 font-semibold">
                      {c.entry.title}
                    </p>
                  )}
                  <pre lang={c.entry.lang} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans">
                    {c.entry.body}
                  </pre>
                </>
              )}
            </PersistentDetails>
          )}
          {c.chat && <Link className="underline" to={`/mod/chat/appeal/${c.id}`}>{m.chat_reports_open()}</Link>}
          {!c.chat && <div>
            <p className="text-sm font-semibold">{m.mod_appeals_text()}</p>
            <pre className="whitespace-pre-wrap font-sans text-sm">{c.text}</pre>
          </div>}
          <Form method="post" className="space-y-2">
            <input type="hidden" name="appealId" value={c.id} />
            <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
              {m.mod_appeals_note()}
              <Textarea name="note" rows={3} maxLength={maxLength} defaultValue={actionData?.appealId === c.id && "note" in actionData ? actionData.note : ""} className="block w-full" />
            </FieldLabel></Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" name="intent" value="uphold" variant="outline">
                {m.mod_appeals_uphold()}
              </Button>
              <Button type="submit" name="intent" value="overturn">
                {m.mod_appeals_overturn()}
              </Button>
            </div>
          </Form>
        </section>
      ))}
      <Pagination page={page} hasNext={hasNext} />
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
