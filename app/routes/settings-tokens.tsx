import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel, FieldLegend, FieldSet } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { data, Form } from "react-router";
import type { Route } from "./+types/settings-tokens";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { TOKEN_NAME_MAX } from "~/lib/token-limits";
import { createApiToken, listApiTokens, revokeApiToken } from "~/lib/tokens.server";
import { m } from "~/paraglide/messages.js";
import { withCredentialSession } from "~/lib/auth/credential-session.server";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";

export function meta({}: Route.MetaArgs) {
  return [{ title: m.tokens_title() }];
}

// Token plaintext appears in the creation response, including page rendering, so prevent storage of every response.
export function headers() {
  return { "Cache-Control": "no-store" };
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  return { tokens: await listApiTokens(db, user.id) };
}

// Token creation and revocation (intent = create | revoke) both require same-origin POSTs from browser sessions.
// Token plaintext appears only in the creation POST response. Omit it from the list; reloading the page makes it unavailable.
// Only revoke the member's own tokens. Another member's token id returns the same 404 as a missing token.
export async function action({ request }: Route.ActionArgs) {
  // Reject creation and revocation from cross-site POSTs; verify here as well as React Router's route-level check.
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  const form = await request.formData();
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (formString(form, "intent") === "revoke") {
    const raw = formString(form, "tokenId");
    const id = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || !(await revokeApiToken(db, user.id, id))) throw data("Not found", { status: 404 });
    return data({ intent: "revoke" as const, error: null, token: null, name: null }, noStore);
  }
  // All members may revoke their own tokens. Creation passes through the writing gate.
  await requireWriter(request);
  const res = await withCredentialSession(db, user.id, request, "/settings/tokens", tx => createApiToken(tx, user.id, { name: formString(form, "name"), kind: formString(form, "kind"), ...(form.has("expiresInDays") ? { expiresInDays: formString(form, "expiresInDays") } : {}) }));
  if (!res.ok) return data({ intent: "create" as const, error: res.error, token: null, name: null }, { status: 400, ...noStore });
  return data({ intent: "create" as const, error: null, token: res.token, name: res.summary.name }, noStore);
}

const errorMessage = (error: string) =>
  error === "invalid_expiry" ? m.tokens_error_expiry() : error === "invalid_name" ? m.tokens_error_name() : error === "invalid_kind" ? m.tokens_error_kind() : error === "too_many_tokens" ? m.tokens_error_limit() : m.tokens_error_generic();

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

export default function SettingsTokens({ loaderData, actionData }: Route.ComponentProps) {
  const { tokens } = loaderData;
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold">{m.tokens_title()}</h1>
      <p className="ui-help text-muted-foreground">
        {m.tokens_intro()}{" "}
        <a href="/help/ai.md" className="underline">
          {m.tokens_help_link()}
        </a>
      </p>

      {actionData?.intent === "create" && actionData.token && (
        <div role="status" className="space-y-2 rounded border border-success-border bg-success-soft p-3">
          <p>{m.tokens_created({ name: actionData.name ?? "" })}</p>
          <code className="block break-all rounded bg-background p-2 font-mono text-sm">{actionData.token}</code>
        </div>
      )}
      {actionData?.intent === "create" && actionData.error && <p className="text-destructive">{errorMessage(actionData.error)}</p>}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{m.tokens_create_heading()}</h2>
        {/* Clear the input after creation by recreating the form after every submission. */}
        <Form method="post" key={actionData?.token ?? "form"} className="space-y-3">
          <input type="hidden" name="intent" value="create" />
          <Field className="min-w-0 w-auto"><FieldLabel className="block">
            {m.tokens_name()}
            <Input name="name" required maxLength={TOKEN_NAME_MAX} className="block w-full" />
          </FieldLabel></Field>
          <FieldSet>
            <FieldLegend>{m.tokens_kind()}</FieldLegend>
            <RadioGroup name="kind" defaultValue="read">
            <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 ">
              <RadioGroupItem value="read" /> {m.tokens_kind_read()}
            </FieldLabel></Field>
            <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 ">
              <RadioGroupItem value="draft" /> {m.tokens_kind_draft()}
            </FieldLabel></Field>
            </RadioGroup>
          </FieldSet>
          <Field className="min-w-0 w-auto"><FieldLabel>{m.tokens_expires()}</FieldLabel>
            <Select name="expiresInDays" defaultValue="90" items={[...[30, 90, 365].map(days => ({ value: String(days), label: m.tokens_expiry_days({ days }) })), { value: "none", label: m.tokens_no_expiry() }]}><SelectTrigger aria-label={m.tokens_expires()}><SelectValue /></SelectTrigger><SelectContent>
              {[30, 90, 365].map(days => <SelectItem key={days} value={String(days)}>{m.tokens_expiry_days({ days })}</SelectItem>)}
              <SelectItem value="none">{m.tokens_no_expiry()}</SelectItem>
            </SelectContent></Select>
          </Field>
          <Button type="submit">
            {m.tokens_create()}
          </Button>
        </Form>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{m.tokens_list_heading()}</h2>
        {actionData?.intent === "revoke" && (
          <p role="status" className="text-success">
            {m.tokens_revoke_done()}
          </p>
        )}
        {tokens.length === 0 ? (
          <p>{m.tokens_empty()}</p>
        ) : (
          <Table className="w-full text-start text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="py-1">{m.tokens_col_name()}</TableHead>
                <TableHead>{m.tokens_col_kind()}</TableHead>
                <TableHead>{m.tokens_col_created()}</TableHead>
                <TableHead>{m.tokens_expires()}</TableHead>
                <TableHead>{m.tokens_col_used()}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id} className={`border-t ${t.revokedAt ? "text-muted-foreground" : ""}`}>
                  <TableCell className="py-1">{t.name}</TableCell>
                  <TableCell>{t.kind === "read" ? m.tokens_kind_read_short() : m.tokens_kind_draft_short()}</TableCell>
                  <TableCell>{dateOf(t.createdAt)}</TableCell>
                  <TableCell><span className="inline-flex flex-wrap gap-x-4">{t.expiresAt ? <><span>{dateOf(t.expiresAt)}</span>{t.expiresAt <= new Date() && <>{" "}<span>{m.tokens_expired()}</span></>}</> : m.tokens_no_expiry()}</span></TableCell>
                  <TableCell>{t.lastUsedAt ? dateOf(t.lastUsedAt) : m.tokens_never_used()}</TableCell>
                  <TableCell>
                    {t.revokedAt ? (
                      m.tokens_revoked()
                    ) : (
                      <Form method="post" onSubmit={(e) => {
                          if (!window.confirm(m.tokens_revoke_confirm())) e.preventDefault();
                        }}>
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="tokenId" value={t.id} />
                        <Button type="submit" variant="destructive">
                          {m.tokens_revoke()}
                        </Button>
                      </Form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
