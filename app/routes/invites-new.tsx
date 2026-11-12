import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { LocalTime } from "~/components/local-time";
import { Button } from "~/components/ui/button";
import { data, Form, useNavigation } from "react-router";
import type { Route } from "./+types/invites-new";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { parseEmail } from "~/lib/email";
import { INVITATION_TTL_DAYS, listInvitations, normalizeEmail, revokeInvitation } from "~/lib/invitations.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { inviteUrl } from "~/lib/site-url";
import { m } from "~/paraglide/messages.js";
import { useEffect, useState } from "react";
import { createSignupInvitation, signupVillageChoices } from "~/lib/signup-village.server";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { invitationNoteText, INVITATION_NOTE_MAX } from "~/lib/invitation-note";
import { canCreateInvitations } from "~/lib/invitation-permissions.server";
import { isOperatorEmail } from "~/lib/operators.server";
import { createOperatorInvitations, OPERATOR_INVITATION_BATCH_MAX, parseInvitationEmails, type OperatorInvitationStatus } from "~/lib/operator-invitations.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { LANG_LABELS } from "~/lib/languages";
import { getLocale } from "~/paraglide/runtime.js";
import { mailLocale } from "~/lib/mail/magic-link.server";

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { db, user } = await requireMember(request);
  const operator = isOperatorEmail(user.email);
  if (!canCreateInvitations(operator)) throw data("Not found", { status: 404 });
  const rows = await listInvitations(db, { createdBy: user.id });
  // Account identities linked to recipient addresses are operator-only data.
  return { operator, mailLanguages: operator ? enabledLangs() : [], locale: getLocale(), batchMax: OPERATOR_INVITATION_BATCH_MAX,
    villages: await signupVillageChoices(db, user.id), ttlDays: INVITATION_TTL_DAYS, invitations: rows.map(({ id, email, status, createdAt, expiresAt }) => ({ id, email, status, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() })) };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  const form = await request.formData();
  const operator = isOperatorEmail(user.email);
  const emailValues = form.getAll("email").map(String);
  const multipleEmails = emailValues.length > 1 || emailValues.some(value => value.split(/[\s,;]+/u).filter(Boolean).length > 1);
  const emails = parseInvitationEmails(emailValues);
  // Reject forged operator fields before the ordinary invitation-visibility gate.
  if (!operator && (multipleEmails || form.has("sendEmail") || form.has("mailLocale"))) {
    return data({ url: null, error: "invalid_operator_request" as const }, { status: 400 });
  }
  if (!canCreateInvitations(operator)) throw data("Not found", { status: 404 });
  if (form.get("intent") === "revoke") {
    if (!await revokeInvitation(db, user.id, String(form.get("id") ?? ""))) throw data("Not found", { status: 404 });
    return { url: null, error: null };
  }
  await requireWriter(request);
  if (operator) {
    const note = invitationNoteText(form.get("note") ?? "");
    if (note === null) return { url: null, error: "invalid_note" as const };
    if (!emails.length) return { url: null, error: "invalid_email" as const };
    const locale = mailLocale(form.get("mailLocale") ?? getLocale());
    if (!locale) return data({ url: null, error: "invalid_mail_locale" as const }, { status: 400 });
    const outcome = await createOperatorInvitations(db, user, { emails, villageId: String(form.get("villageId") ?? "") || null,
      note, sendEmail: form.get("sendEmail") === "1", locale });
    if (outcome.error === "rate_limited" && outcome.rate) return data({ url: null, error: "bulk_rate_limited" as const, remaining: outcome.rate.remaining }, { status: 429, headers: rateLimitHeaders(outcome.rate) });
    if (outcome.error) return { url: null, error: outcome.error };
    return { url: null, error: null, results: outcome.results };
  }
  const email = parseEmail(String(form.get("email") ?? ""));
  if (!email) return { url: null, error: "invalid_email" as const };
  if (email === normalizeEmail(user.email)) return { url: null, error: "self_invitation" as const };
  const note = invitationNoteText(form.get("note") ?? "");
  if (note === null) return { url: null, error: "invalid_note" as const };
  // Limit invitation creation to 20 per member per day because invitations can send login email to arbitrary recipients. Excess returns 429 and a UI message.
  const rate = await hitMemberLimit(db, "invitation", user.id);
  if (!rate.allowed) return data({ url: null, error: "rate_limited" as const }, { status: 429, headers: rateLimitHeaders(rate) });
  const created = await createSignupInvitation(db, user.id, email, String(form.get("villageId") ?? "") || null, note);
  if (!created) return { url: null, error: "invalid_village" as const };
  const { token } = created;
  // Use the same base as scripts/create-invite.ts (BETTER_AUTH_URL via app/lib/site-url.ts), not the request origin.
  return { url: inviteUrl(token), error: null };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.invites_title() }];
}

export default function InvitesNew({ actionData, loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const results = actionData && "results" in actionData ? actionData.results : undefined;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.invites_title()}</h1>
      <Form method="post" className="space-y-2">
        <Field className="min-w-0 w-auto"><FieldLabel className="block">
          {loaderData.operator ? m.invites_bulk_emails() : m.invites_email()}
          {loaderData.operator ? <Textarea name="email" required rows={5} className="block w-full" aria-describedby="bulk-email-help" /> : <Input name="email" type="email" required className="block w-full" />}
        </FieldLabel></Field>
        {loaderData.operator && <>
          <p id="bulk-email-help" className="ui-help text-muted-foreground">{m.invites_bulk_help({ max: loaderData.batchMax })}</p>
          <label className="flex items-center gap-2"><input type="checkbox" name="sendEmail" value="1" defaultChecked />{m.invites_bulk_send_email()}</label>
          <Field className="min-w-0 w-auto"><FieldLabel className="block">{m.invites_bulk_mail_language()}
            <Select name="mailLocale" defaultValue={loaderData.locale} items={loaderData.mailLanguages.map(lang => ({ value: lang, label: LANG_LABELS[lang] }))}>
              <SelectTrigger className="w-full" aria-label={m.invites_bulk_mail_language()}><SelectValue /></SelectTrigger>
              <SelectContent>{loaderData.mailLanguages.map(lang => <SelectItem key={lang} value={lang}>{LANG_LABELS[lang]}</SelectItem>)}</SelectContent>
            </Select>
          </FieldLabel></Field>
        </>}
        {loaderData.villages.length > 0 && <Field className="min-w-0 w-auto"><FieldLabel className="block">{m.invites_village()}
          <Select name="villageId" defaultValue="" items={[{ value: "", label: m.invites_village_none() }, ...loaderData.villages.map(village => ({ value: village.id, label: village.name }))]}>
            <SelectTrigger className="w-full" aria-label={m.invites_village()}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="">{m.invites_village_none()}</SelectItem>{loaderData.villages.map(village => <SelectItem key={village.id} value={village.id}>{village.name}</SelectItem>)}</SelectContent>
          </Select>
        </FieldLabel></Field>}
        <Field className="min-w-0 w-auto"><FieldLabel className="block">
          {m.invites_note()}
          <Input name="note" type="text" className="block w-full" aria-invalid={actionData?.error === "invalid_note" || undefined} aria-describedby={actionData?.error === "invalid_note" ? "note-error" : undefined} />
        </FieldLabel></Field>
        <p className="ui-help text-muted-foreground">{loaderData.operator ? m.invites_bulk_link_rules({ days: loaderData.ttlDays }) : m.invites_help({ days: loaderData.ttlDays })}</p>
        <Button type="submit" disabled={loaderData.operator && navigation.state !== "idle"}>
          {loaderData.operator ? m.invites_bulk_submit() : m.invites_submit()}
        </Button>
      </Form>
      {actionData?.error === "invalid_email" && <p className="text-destructive">{m.invites_invalid_email()}</p>}
      {actionData?.error === "invalid_note" && <p id="note-error" role="alert" className="text-destructive">{m.invites_note_invalid({ max: INVITATION_NOTE_MAX })}</p>}
      {actionData?.error === "self_invitation" && <p role="alert" className="text-destructive">{m.invites_self()}</p>}
      {actionData?.error === "invalid_village" && <p role="alert" className="text-destructive">{m.error_generic()}</p>}
      {actionData?.error === "rate_limited" && <p className="text-destructive">{m.invites_rate_limited()}</p>}
      {actionData?.error === "bulk_rate_limited" && <p role="alert" className="text-destructive">{m.invites_bulk_remaining({ remaining: "remaining" in actionData ? actionData.remaining : 0 })}</p>}
      {actionData?.error === "too_many" && <p role="alert" className="text-destructive">{m.invites_bulk_too_many({ max: loaderData.batchMax })}</p>}
      {(actionData?.error === "invalid_mail_locale" || actionData?.error === "invalid_operator_request") && <p role="alert" className="text-destructive">{m.error_generic()}</p>}
      {results && <section aria-label={m.invites_bulk_results()} className="space-y-2">
        <h2 className="text-xl font-semibold">{m.invites_bulk_results()}</h2>
        <ul className="divide-y">{results.map(result => <li key={result.email} className="space-y-2 py-2">
          <p className="break-all">{result.email}: {invitationStatusText(result.status)}</p>
          {result.url && <InvitationLink url={result.url} compact />}
        </li>)}</ul>
        {results.some(result => result.url) && <p className="ui-help text-muted-foreground">{m.invites_once()}</p>}
      </section>}
      {actionData?.url && <InvitationLink key={actionData.url} url={actionData.url} />}
      {actionData?.url && <p className="ui-help text-muted-foreground">{m.invites_once()}</p>}
      {/* The list has a heading only when there is something in it; an empty list says nothing. */}
      {loaderData.invitations.length > 0 && <section className="space-y-2">
        <h2 className="text-xl font-semibold">{m.invites_history()}</h2>
        <ul className="divide-y">{loaderData.invitations.map(invitation => <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-2">
          <span>{invitation.email ?? m.invites_recipient_removed()}</span>
          <span className="ui-meta text-muted-foreground"><LocalTime iso={invitation.createdAt} /></span>
          <span>{invitation.status === "valid" ? m.admin_invitations_status_valid() : invitation.status === "used" ? m.admin_invitations_status_used() : invitation.status === "revoked" ? m.invites_revoked() : m.admin_invitations_status_expired()}</span>
          {invitation.status === "valid" && <span className="ui-meta text-muted-foreground">{m.invites_until()} <LocalTime iso={invitation.expiresAt} /></span>}
          {invitation.status === "valid" && <Form method="post"><input type="hidden" name="intent" value="revoke" /><input type="hidden" name="id" value={invitation.id} /><Button type="submit" variant="outline">{m.invites_revoke()}</Button></Form>}
        </li>)}</ul>
      </section>}
    </main>
  );
}

function invitationStatusText(status: OperatorInvitationStatus): string {
  const messages = { sent: m.invites_result_sent, created: m.invites_result_created, member: m.invites_result_member,
    existing: m.invites_result_existing, ineligible: m.invites_result_ineligible, invalid: m.invites_invalid_email,
    self: m.invites_self, send_failed: m.invites_result_send_failed };
  return messages[status]();
}

function InvitationLink({ url, compact = false }: { url: string; compact?: boolean }) {
  const [notice, setNotice] = useState<"copied" | "message_copied" | "failed" | null>(null);
  // The share sheet is offered only where the browser has one (mostly phones), after hydration.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator.share === "function"), []);
  const message = m.invites_message({ url });
  async function copy(text: string, done: "copied" | "message_copied") {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(done);
    } catch {
      setNotice("failed");
    }
  }
  async function share() {
    try { await navigator.share({ text: message }); } catch { /* Closing the share sheet is not an error. */ }
  }
  return (
    <div className="space-y-3">
      <p>{m.invites_created()} <code className="break-all">{url}</code></p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void copy(url, "copied")} variant="outline">{m.invites_copy()}</Button>
      </div>
      {!compact && <div className="space-y-2">
        <label htmlFor="invitation-message" className="block ui-meta text-muted-foreground">{m.invites_message_label()}</label>
        <Textarea id="invitation-message" readOnly rows={4} value={message} className="block w-full text-sm" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void copy(message, "message_copied")} variant="outline">{m.invites_copy_message()}</Button>
          {canShare && <Button type="button" onClick={() => void share()} variant="outline">{m.invites_share()}</Button>}
        </div>
      </div>}
      {notice && <p role="status">{notice === "copied" ? m.invites_copied() : notice === "message_copied" ? m.invites_message_copied() : m.invites_copy_failed()}</p>}
    </div>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
