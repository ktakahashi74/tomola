import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { LocalTime } from "~/components/local-time";
import { Button } from "~/components/ui/button";
import { data, Form } from "react-router";
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

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { db, user } = await requireMember(request);
  if (!canCreateInvitations(isOperatorEmail(user.email))) throw data("Not found", { status: 404 });
  const rows = await listInvitations(db, { createdBy: user.id });
  // Account identities linked to recipient addresses are operator-only data.
  return { villages: await signupVillageChoices(db, user.id), ttlDays: INVITATION_TTL_DAYS, invitations: rows.map(({ id, email, status, createdAt, expiresAt }) => ({ id, email, status, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() })) };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  if (!canCreateInvitations(isOperatorEmail(user.email))) throw data("Not found", { status: 404 });
  const form = await request.formData();
  if (form.get("intent") === "revoke") {
    if (!await revokeInvitation(db, user.id, String(form.get("id") ?? ""))) throw data("Not found", { status: 404 });
    return { url: null, error: null };
  }
  await requireWriter(request);
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
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.invites_title()}</h1>
      <Form method="post" className="space-y-2">
        <Field className="min-w-0 w-auto"><FieldLabel className="block">
          {m.invites_email()}
          <Input name="email" type="email" required className="block w-full" />
        </FieldLabel></Field>
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
        <p className="ui-help text-muted-foreground">{m.invites_help({ days: loaderData.ttlDays })}</p>
        <Button type="submit">
          {m.invites_submit()}
        </Button>
      </Form>
      {actionData?.error === "invalid_email" && <p className="text-destructive">{m.invites_invalid_email()}</p>}
      {actionData?.error === "invalid_note" && <p id="note-error" role="alert" className="text-destructive">{m.invites_note_invalid({ max: INVITATION_NOTE_MAX })}</p>}
      {actionData?.error === "self_invitation" && <p role="alert" className="text-destructive">{m.invites_self()}</p>}
      {actionData?.error === "invalid_village" && <p role="alert" className="text-destructive">{m.error_generic()}</p>}
      {actionData?.error === "rate_limited" && <p className="text-destructive">{m.invites_rate_limited()}</p>}
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

function InvitationLink({ url }: { url: string }) {
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
      <div className="space-y-2">
        <label htmlFor="invitation-message" className="block ui-meta text-muted-foreground">{m.invites_message_label()}</label>
        <Textarea id="invitation-message" readOnly rows={4} value={message} className="block w-full text-sm" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void copy(message, "message_copied")} variant="outline">{m.invites_copy_message()}</Button>
          {canShare && <Button type="button" onClick={() => void share()} variant="outline">{m.invites_share()}</Button>}
        </div>
      </div>
      {notice && <p role="status">{notice === "copied" ? m.invites_copied() : notice === "message_copied" ? m.invites_message_copied() : m.invites_copy_failed()}</p>}
    </div>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
