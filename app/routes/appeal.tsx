import { DisplayNameEvidence } from "~/components/display-name-evidence";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { PersistentDetails } from "~/components/persistent-details";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/appeal";
import { appealActionText } from "~/components/appeal-action";
import { VillageAppealDetails } from "~/components/village-moderation";
import { FixBeforeNow } from "~/components/fix-before-now";
import { reasonLabel } from "~/components/reason-label";
import { createAppeal, getAppealableAction, MAX_APPEAL_TEXT } from "~/lib/appeals.server";
import { requireMember } from "~/lib/auth/session.server";
import { replyLocation } from "~/lib/entries.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { LANG_LABELS } from "~/lib/languages";
import { parseId } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

// Appeal screen for the affected member: author of a hidden/deleted post, suspended member, or member whose stances and 「なるほど」 are excluded. One appeal per action; only that member can open it (404 for others).
// Suspended members may appeal via requireMember, outside the writing gate. Review belongs to another moderator or operator, distinct from the actor (/mod/appeals).
export const middleware = [privateCacheMiddleware];
export function headers() { return CHAT_PRIVATE_HEADERS; }
export function meta({}: Route.MetaArgs) {
  return [{ title: m.appeal_title() }];
}

async function loaderImplementation({ request, params }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  const found = await getAppealableAction(db, user.id, parseId(params.actionId));
  if (!found) throw data("Not found", { status: 404 });
  const url = new URL(request.url);
  const payload = {
    ...(found.avatarUrl ? { avatarUrl: found.avatarUrl } : {}),
    ...(found.chat ? { chat: found.chat } : {}),
    ...(found.village !== undefined ? { village: found.village, villageBefore: found.villageBefore ?? null, villageAppealOwn: found.villageAppealOwn ?? true } : {}),
    ...(found.displayNames ? { displayNames: found.displayNames } : {}),
    actionId: found.actionId,
    automatic: found.automatic ?? false,
    action: found.action,
    reason: found.reason,
    note: found.automatic ? "" : found.note,
    date: found.createdAt.toISOString().slice(0, 10),
    until: found.until ? found.until.toISOString().slice(0, 16).replace("T", " ") : null,
    entry: found.entry,
    before: found.before,
    appeal: found.appeal
      ? { status: found.appeal.status, text: found.appeal.text, decisionNote: found.appeal.decisionNote, reversed: found.appeal.reversed, createdAt: found.appeal.createdAt.toISOString().slice(0, 10) }
      : null,
    entryHref: found.entry && (found.action === "hide" || found.action === "fix_entry")
      ? found.entry.kind === "topic" ? `/t/${found.entry.id}` : await replyLocation(db, found.entry.threadId, found.entry.id)
      : null,
    sent: url.searchParams.get("sent") === "1",
    maxLength: MAX_APPEAL_TEXT,
  };
  return found.chat ? data(payload, { headers: CHAT_PRIVATE_HEADERS }) : payload;
}

export async function action({ request, params }: Route.ActionArgs) {
  // Reject changes from cross-site POSTs (CSRF), checking before authentication or input parsing (csrf.server.ts convention).
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  const actionId = parseId(params.actionId);
  const form = await request.formData();
  const res = await createAppeal(db, user.id, actionId, formString(form, "text"));
  if (res.ok) throw redirect(`/appeal/${actionId}?sent=1`);
  if (res.error === "not_found") throw data("Not found", { status: 404 });
  return data({ error: res.error, text: formString(form, "text") }, { status: res.error === "duplicate" ? 409 : 400 });
}

export default function Appeal({ loaderData, actionData }: Route.ComponentProps) {
  const { action, reason, note, date, until, entry, before, appeal, sent, maxLength, entryHref } = loaderData;
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold">{m.appeal_title()}</h1>
      <section className="space-y-2 rounded border p-4">
        <p className="font-semibold">{appealActionText(action, until)}</p>
        <p className="ui-meta">{m.appeal_date({ date })}</p>
        {loaderData.automatic && <p>{m.moderation_automatic()}</p>}
        <p className="ui-meta">{m.notification_reason({ reason: reasonLabel(reason) })}</p>
        {note && <p className="text-sm">{m.notification_note({ note })}</p>}
        {"village" in loaderData && <VillageAppealDetails village={loaderData.village ?? null} before={loaderData.villageBefore ?? null} />}
        {loaderData.avatarUrl && <img src={loaderData.avatarUrl} alt="" width="64" height="64" className="rounded" />}
        {loaderData.displayNames && <DisplayNameEvidence names={loaderData.displayNames} />}
        {action === "end_village" && <p className="ui-help">{m.village_appeal_end_help()}</p>}
        {"chat" in loaderData && loaderData.chat && <section className="space-y-2" aria-label={m.chat_reports_snapshot()}>
          <h2>{m.chat_reports_snapshot()}</h2>
          {loaderData.chat.body === null ? <p>{m.chat_reports_pruned()}</p> : <pre lang={loaderData.chat.lang} className="whitespace-pre-wrap font-sans">{loaderData.chat.body}</pre>}
        </section>}
        {entry && (
          <PersistentDetails open={action === "fix_entry"} className="text-sm">
            <summary className="cursor-pointer ui-meta">
              {m.appeal_entry()} · <span lang={entry.lang}>{entry.lang === "other" ? m.source_language_other() : LANG_LABELS[entry.lang]}</span>
            </summary>
            {action === "fix_entry" ? (
              <FixBeforeNow before={before} now={{ title: entry.title, body: entry.body }} lang={entry.lang} />
            ) : (
              <>
                {entry.title && (
                  <p lang={entry.lang} className="mt-2 font-semibold">
                    {entry.title}
                  </p>
                )}
                <pre lang={entry.lang} className="mt-2 whitespace-pre-wrap font-sans">
                  {entry.body}
                </pre>
              </>
            )}
          </PersistentDetails>
        )}
      </section>
      {appeal ? (
        <section className="space-y-2" aria-live="polite">
          {sent && (
            <p role="status" className="text-success">
              {m.appeal_sent()}
            </p>
          )}
          <h2 className="text-lg font-semibold">{"villageAppealOwn" in loaderData && !loaderData.villageAppealOwn ? m.village_appeal_shared() : m.appeal_yours()}</h2>
          <pre className="whitespace-pre-wrap font-sans text-sm">{appeal.text}</pre>
          <p>
            {appeal.status === "open"
              ? m.appeal_status_open()
              : appeal.status === "upheld"
                ? m.appeal_status_upheld()
                : appeal.reversed === false
                  ? m.appeal_status_overturned_nochange()
                  : m.appeal_status_overturned()}
          </p>
          {appeal.decisionNote && <p className="text-sm">{m.appeal_decision_note({ note: appeal.decisionNote })}</p>}
        </section>
      ) : (
        <Form method="post" className="space-y-3">
          <FieldDescription className="ui-help text-muted-foreground">{m.appeal_help()}</FieldDescription>
          <Field className="min-w-0 w-auto"><FieldLabel className="block">
            {m.appeal_text()}
            <Textarea name="text" required rows={6} maxLength={maxLength} defaultValue={actionData?.text ?? ""} className="block w-full" />
          </FieldLabel></Field>
          {actionData?.error === "duplicate" && <p className="text-destructive">{m.appeal_error_duplicate()}</p>}
          {actionData?.error === "invalid_text" && <p className="text-destructive">{m.appeal_error_text({ max: maxLength })}</p>}
          <Button type="submit">
            {m.appeal_submit()}
          </Button>
        </Form>
      )}
      <p className="flex flex-wrap gap-3">
        {entryHref && <Link to={entryHref} className="ui-meta underline">{m.card_open()}</Link>}
        <Link to="/notifications" className="ui-meta underline">
          {m.appeal_back()}
        </Link>
      </p>
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
