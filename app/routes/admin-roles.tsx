import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import { data, Form, redirect } from "react-router";
import type { Route } from "./+types/admin-roles";
import { requireOperator } from "~/lib/auth/session.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { reasonLabel } from "~/components/reason-label";
import { LANG_LABELS, LANGS } from "~/lib/languages";
import { MAX_SUSPEND_DAYS, REPORT_REASONS } from "~/lib/moderation";
import { revokeAllCredentials } from "~/lib/auth/revoke-credentials.server";
import { grantModerator, listModerators, revokeModerator, searchMembers } from "~/lib/roles.server";
import { m } from "~/paraglide/messages.js";

// Operators only (404 for other members). Find members by display name and appoint or remove moderators per language.
// Log appointments and removals server-side; roles.granted_by also records the appointing operator.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.admin_roles_title() }];
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { db } = await requireOperator(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  const saved = url.searchParams.get("saved");
  return {
    q,
    hits: (await searchMembers(db, q)).map((h) => ({ ...h, suspendedUntil: h.suspendedUntil ? h.suspendedUntil.toISOString().slice(0, 16).replace("T", " ") : null })),
    moderators: (await listModerators(db)).map((r) => ({ userId: r.userId, handle: r.handle, lang: r.lang, grantedByHandle: r.grantedByHandle, createdAt: r.createdAt.toISOString().slice(0, 10) })),
    saved: saved === "granted" || saved === "revoked" || saved === "tokens" ? saved : null,
    tokensRevoked: Number(url.searchParams.get("n")) || 0,
  };
}

export async function action({ request }: Route.ActionArgs) {
  // Reject changes from cross-site POSTs (CSRF), checking before authentication or input parsing (csrf.server.ts convention).
  assertSameOrigin(request);
  const { user, db } = await requireOperator(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  const userId = formString(form, "userId");
  const lang = formString(form, "lang");
  const back = (saved: string) => `/admin/roles?${new URLSearchParams({ q: formString(form, "q").slice(0, 100), saved }).toString()}`;
  if (intent === "grant") {
    const res = await grantModerator(db, user.id, userId, lang);
    if (!res.ok) return data({ error: res.error }, { status: 400 });
    console.info(`[roles] moderator granted: user=${userId} lang=${lang} by=${user.id} added=${res.added}`);
    throw redirect(back("granted"));
  }
  if (intent === "revoke") {
    const res = await revokeModerator(db, userId, lang);
    if (!res.ok) return data({ error: res.error }, { status: 400 });
    console.info(`[roles] moderator revoked: user=${userId} lang=${lang} by=${user.id} removed=${res.removed}`);
    throw redirect(back("revoked"));
  }
  // Invalidate all a member's tokens and signed 「AIで開く」 links for compromise response. Require the confirmation checkbox.
  if (intent === "revoke-tokens") {
    if (formString(form, "confirm") !== "1") return data({ error: "confirm_required" }, { status: 400 });
    const result = await revokeAllCredentials(db, userId);
    if (!result.ok) return data({ error: "not_a_member" }, { status: 400 });
    const revoked = result.tokens;
    console.info(`[roles] tokens revoked: user=${userId} tokens=${revoked} by=${user.id}`);
    throw redirect(`/admin/roles?${new URLSearchParams({ q: formString(form, "q").slice(0, 100), saved: "tokens", n: String(revoked) }).toString()}`);
  }
  throw data("Bad request", { status: 400 });
}

export default function AdminRoles({ loaderData, actionData }: Route.ComponentProps) {
  const { q, hits, moderators, saved, tokensRevoked } = loaderData;
  return (
    <main className="space-y-8">
      <h1 className="text-2xl font-bold">{m.admin_roles_title()}</h1>
      <p className="ui-help text-muted-foreground">{m.admin_roles_intro()}</p>
      {saved === "granted" && <p role="status" className="text-success">{m.admin_roles_granted()}</p>}
      {saved === "revoked" && <p role="status" className="text-success">{m.admin_roles_revoked()}</p>}
      {saved === "tokens" && <p role="status" className="text-success">{m.admin_roles_tokens_done({ count: tokensRevoked })}</p>}
      {actionData?.error === "confirm_required" && <p role="alert" className="text-destructive">{m.mod_error_confirm()}</p>}
      {actionData?.error && actionData.error !== "confirm_required" && <p role="alert" className="text-destructive">{m.admin_roles_error()}</p>}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{m.admin_roles_search_heading()}</h2>
        <Form method="get" className="flex flex-wrap items-end gap-2">
          <Field className="min-w-0 w-auto"><FieldLabel className="block">
            {m.admin_roles_search_label()}
            <Input name="q" defaultValue={q} maxLength={100} className="block" />
          </FieldLabel></Field>
          <Button type="submit" variant="outline">
            {m.admin_roles_search_submit()}
          </Button>
        </Form>
        {q !== "" && hits.length === 0 && <p>{m.admin_roles_no_hits()}</p>}
        <ul className="space-y-3">
          {hits.map((h) => (
            <li key={h.userId} className="space-y-2 rounded border p-3">
              <div className="font-semibold">
                @{h.handle}
                {h.operator && <Badge className="ms-2 ui-meta font-normal" variant="secondary">{m.admin_roles_operator()}</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                {LANGS.map((l) => {
                  const held = h.moderatorLangs.includes(l);
                  return (
                    <Form key={l} method="post">
                      <input type="hidden" name="intent" value={held ? "revoke" : "grant"} />
                      <input type="hidden" name="userId" value={h.userId} />
                      <input type="hidden" name="lang" value={l} />
                      <input type="hidden" name="q" value={q} />
                      <Button type="submit" marked={held} variant="outline">
                        {held ? m.admin_roles_revoke({ lang: LANG_LABELS[l] }) : m.admin_roles_grant({ lang: LANG_LABELS[l] })}
                      </Button>
                    </Form>
                  );
                })}
              </div>
              {/* Suspension: operators may suspend any member for up to 365 days. /mod action applies it, then returns here. */}
              <Form method="post" action="/mod" className="flex flex-wrap items-end gap-2 border-t pt-2 text-sm">
                <input type="hidden" name="userId" value={h.userId} />
                <input type="hidden" name="returnTo" value={`/admin/roles?q=${encodeURIComponent(q)}`} />
                {h.suspendedUntil && <span className="ui-meta">{m.admin_roles_suspended_until({ until: h.suspendedUntil })}</span>}
                <Field className="min-w-0 w-auto"><FieldLabel className="block">
                  {m.mod_reason()}
                  <Select name="reason" defaultValue="other" items={[...REPORT_REASONS.map((r) => (
                      { value: r, label: reasonLabel(r) }
                    ))]}>
              <SelectTrigger className="w-full min-w-0" aria-label={m.mod_reason()}><SelectValue /></SelectTrigger>
              <SelectContent>
                    {REPORT_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {reasonLabel(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
            </Select>
                </FieldLabel></Field>
                <Field className="min-w-0 w-auto"><FieldLabel className="block">
                  {m.mod_note_short()}
                  <Input name="note" maxLength={500} className="block" />
                </FieldLabel></Field>
                {h.suspendedUntil ? (
                  <Button type="submit" name="intent" value="unsuspend" variant="outline">
                    {m.mod_unsuspend()}
                  </Button>
                ) : (
                  <>
                    <Field className="min-w-0 w-auto"><FieldLabel className="block">
                      {m.mod_days({ max: MAX_SUSPEND_DAYS.operator })}
                      <Input name="days" type="number" min={1} max={MAX_SUSPEND_DAYS.operator} defaultValue={7} className="block w-24" />
                    </FieldLabel></Field>
                    <Button type="submit" name="intent" value="suspend" variant="destructive">
                      {m.mod_suspend()}
                    </Button>
                  </>
                )}
              </Form>
              {/* Exclude stances and 「なるほど」 of members deemed fake accounts or manipulators from counts. Operators only; /mod action applies it and returns here. Explanation required; revocation uses a separate form. */}
              <div className="space-y-2 border-t pt-2 text-sm">
                <p className="ui-help text-muted-foreground">{m.mod_exclude_help()}</p>
                {h.reactionsExcluded ? (
                  <Form method="post" action="/mod" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="intent" value="include-reactions" />
                    <input type="hidden" name="userId" value={h.userId} />
                    <input type="hidden" name="reason" value="other" />
                    <input type="hidden" name="returnTo" value={`/admin/roles?q=${encodeURIComponent(q)}`} />
                    <span role="status" className="rounded bg-notice px-1.5 py-0.5 ui-meta text-notice-foreground">
                      {m.admin_roles_reactions_excluded()}
                    </span>
                    <Field className="min-w-0 w-auto"><FieldLabel className="block">
                      {m.mod_note_short()}
                      <Input name="note" maxLength={500} className="block" />
                    </FieldLabel></Field>
                    <Button type="submit" variant="outline">
                      {m.mod_include_reactions()}
                    </Button>
                  </Form>
                ) : (
                  !h.operator && (
                    <Form method="post" action="/mod" className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="intent" value="exclude-reactions" />
                      <input type="hidden" name="userId" value={h.userId} />
                      <input type="hidden" name="returnTo" value={`/admin/roles?q=${encodeURIComponent(q)}`} />
                      <Field className="min-w-0 w-auto"><FieldLabel className="block">
                        {m.mod_reason()}
                        <Select name="reason" defaultValue="other" items={[...REPORT_REASONS.map((r) => (
                            { value: r, label: reasonLabel(r) }
                          ))]}>
              <SelectTrigger className="w-full min-w-0" aria-label={m.mod_reason()}><SelectValue /></SelectTrigger>
              <SelectContent>
                          {REPORT_REASONS.map((r) => (
                            <SelectItem key={r} value={r}>
                              {reasonLabel(r)}
                            </SelectItem>
                          ))}
                        </SelectContent>
            </Select>
                      </FieldLabel></Field>
                      <Field className="min-w-0 w-auto"><FieldLabel className="block">
                        {m.mod_note_short()}
                        <Input name="note" required maxLength={500} className="block" />
                      </FieldLabel></Field>
                      <Button type="submit" variant="outline">
                        {m.mod_exclude_reactions()}
                      </Button>
                    </Form>
                  )
                )}
              </div>
              {/* Compromise response: invalidate all the member's tokens and 「AIで開く」 links. */}
              <Form method="post" className="flex flex-wrap items-center gap-3 border-t pt-2 text-sm">
                <input type="hidden" name="intent" value="revoke-tokens" />
                <input type="hidden" name="userId" value={h.userId} />
                <input type="hidden" name="q" value={q} />
                <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel >
                  <Checkbox name="confirm" value="1" /> {m.admin_roles_tokens_confirm()}
                </FieldLabel></Field>
                <Button type="submit" variant="destructive" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5">
                  {m.admin_roles_tokens_revoke()}
                </Button>
              </Form>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{m.admin_roles_current()}</h2>
        {moderators.length === 0 ? (
          <p>{m.admin_roles_none()}</p>
        ) : (
          <ul className="space-y-1">
            {moderators.map((r) => (
              <li key={`${r.userId}:${r.lang}`} className="flex flex-wrap items-center gap-3">
                <span lang={r.lang}>{LANG_LABELS[r.lang]}</span>
                <span>@{r.handle ?? "?"}</span>
                <span className="ui-meta text-muted-foreground">{m.admin_roles_since({ date: r.createdAt })}</span>
                <Form method="post">
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="userId" value={r.userId} />
                  <input type="hidden" name="lang" value={r.lang} />
                  <input type="hidden" name="q" value={q} />
                  <Button type="submit" className="text-sm" variant="destructive">
                    {m.admin_roles_revoke_short()}
                  </Button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
