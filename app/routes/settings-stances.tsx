import { useOperatorSettings } from "~/lib/operator-context";
import { operatorCopy } from "~/lib/operator-settings";
import { getLocale } from "~/paraglide/runtime.js";
import { hasStanceConsent } from "~/lib/trial-consent.server";
import { setStanceConsent } from "~/lib/trial-consent.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Field, FieldLabel } from "~/components/ui/field";
import { Checkbox } from "~/components/ui/checkbox";
import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/settings-stances";
import { requireMember } from "~/lib/auth/session.server";
import { displayLangFor, screenReadLangsFor } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { getViewer } from "~/lib/roles.server";
import { isPosition, type Position } from "~/lib/stances";
import { deleteStanceRecord, listOwnStanceRecords } from "~/lib/stances.server";
import { m } from "~/paraglide/messages.js";
import { useState } from "react";
import { selectedRecordsMarkdown } from "~/lib/personal-records";
import { stanceResumeCookie } from "~/lib/stance-resume.server";

function pendingChoice(form: FormData) {
  const raw = formString(form, "questionId");
  const questionId = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  const position = formString(form, "position");
  return Number.isSafeInteger(questionId) && isPosition(position) ? { questionId, position } : null;
}

// Member's own stance records: chosen questions, chronological change history, and per-question deletion with confirmation. Only the owner may view; read only their rows.
// Inference-risk disclosure at id="privacy", linked from the stance panel. Suspended members may delete records via requireMember, as with their own posts. The right to deletion takes precedence over
// append-only records. No rate limit. Deleting records does not unlock the question's title and body.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.settings_stances_title() }];
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const records = await listOwnStanceRecords(db, user.id, { readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile), viewer: await getViewer(db, user) });
  return {
    consent: hasStanceConsent(profile),
    next: safeLocalPath(new URL(request.url).searchParams.get("next")),
    deleted: new URL(request.url).searchParams.get("deleted") === "1",
    records: records.map((r) => ({
      questionId: r.questionId,
      state: r.question.state,
      title: r.question.title,
      position: r.position,
      changes: r.changes.map((c) => ({ from: c.from, to: c.to, at: c.at.toISOString().slice(0, 16).replace("T", " "), atIso: c.at.toISOString(), trigger: c.trigger })),
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  // Reject record deletion from cross-site POSTs (CSRF), checking before authentication or input parsing.
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  // /stance redirects its POST here with 307. This only prepares the consent
  // form; no consent, stance, or resume cookie is written at this point.
  if (intent === "" && pendingChoice(form)) return { pending: pendingChoice(form), error: null, questionId: 0 };
  if (intent === "consent" || intent === "revoke-consent") {
    if (intent === "consent" && formString(form, "agree") !== "1") return data({ error: "confirm_required" as const, questionId: 0 }, { status: 400 });
    const result = await setStanceConsent(db, user.id, intent === "consent", Number(formString(form, "version")));
    if (!result.ok) return data({ error: "confirm_required" as const, questionId: 0 }, { status: 400 });
    const next = safeLocalPath(formString(form, "next"));
    if (intent === "consent" && next !== "/") {
      const destination = new URL(next, "http://tomola.invalid");
      for (const key of ["stance_choice", "stance_q", "stance_msg"]) destination.searchParams.delete(key);
      const pending = pendingChoice(form);
      const headers = new Headers();
      if (pending && destination.pathname === `/t/${pending.questionId}`) {
        const cookie = stanceResumeCookie(request, user.id, pending.questionId, pending.position);
        if (cookie) {
          headers.append("Set-Cookie", cookie);
          // The cookie's exact document Path must not be widened to cover the
          // router's .data transport URL. Consume it on a document navigation.
          headers.set("X-Remix-Reload-Document", "true");
        }
      }
      throw redirect(`${destination.pathname}${destination.search}${destination.hash}`, { headers });
    }
    throw redirect("/settings/stances#consent");
  }
  if (intent !== "delete") throw data("Bad request", { status: 400 });
  const raw = formString(form, "questionId");
  const questionId = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(questionId)) throw data("Bad request", { status: 400 });
  // Do not delete without the confirmation checkbox.
  if (formString(form, "confirm") !== "1") return data({ error: "confirm_required" as const, questionId }, { status: 400 });
  await deleteStanceRecord(db, user.id, questionId);
  throw redirect("/settings/stances?deleted=1");
}

const positionLabel = (p: Position): string => (p === "agree" ? m.stance_agree() : p === "disagree" ? m.stance_disagree() : m.stance_neither());
const maybeLabel = (p: Position | null): string => (p === null ? m.settings_stances_none_label() : positionLabel(p));

export default function SettingsStances({ loaderData, actionData }: Route.ComponentProps) {
  const settings = useOperatorSettings();
  const policy = settings.participation;
  const policyCopy = operatorCopy(settings, getLocale());
  const { records, deleted } = loaderData;
  const pending = actionData && "pending" in actionData ? actionData.pending : null;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed" | "empty">("idle");
  const [copied, setCopied] = useState("");
  async function copy() {
    const text = selectedRecordsMarkdown(records, selected);
    if (!text) { setCopyState("empty"); return; }
    setCopied(text);
    try { await navigator.clipboard.writeText(text); setCopyState("done"); }
    catch { setCopyState("failed"); }
  }
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold">{m.settings_stances_title()}</h1>
      <p className="ui-help text-muted-foreground">{m.settings_stances_intro()}</p>
      <section className="space-y-2 rounded border p-3">
        <p>{m.stances_copy_warning()}</p>
        <Button type="button" onClick={() => void copy()} disabled={!records.length} variant="outline">{m.stances_copy_button()}</Button>
        {copyState !== "idle" && <p role="status">{copyState === "done" ? m.stances_copy_done() : copyState === "empty" ? m.stances_copy_empty() : m.stances_copy_failed()}</p>}
        {copyState === "failed" && <Textarea readOnly value={copied} rows={12} aria-label="Markdown" className="block w-full" onFocus={event => event.currentTarget.select()} />}
      </section>
      <section id="consent" className="space-y-3 rounded border p-3">
        <h2 className="text-lg font-semibold">{m.stance_consent_title()}</h2>
        <p>{m.stance_consent_text({ lookupPolicy: policyCopy.stanceConsent })}</p>
        {loaderData.consent && <p role="status">{m.stance_consent_active()}</p>}
        <Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value={loaderData.consent ? "revoke-consent" : "consent"} />
          <input type="hidden" name="version" value={policy.stanceConsentVersion} />
          <input type="hidden" name="next" value={loaderData.next} />
          {pending && <><input type="hidden" name="questionId" value={pending.questionId} /><input type="hidden" name="position" value={pending.position} /></>}
          {!loaderData.consent && <Field orientation="horizontal"><FieldLabel><input type="checkbox" name="agree" value="1" required className="size-4 shrink-0 accent-primary" />{m.stance_consent_agree()}</FieldLabel></Field>}
          <Button type="submit" variant="outline">{loaderData.consent ? m.stance_consent_revoke() : m.stance_consent_continue()}</Button>
          {actionData?.error && actionData.questionId === 0 && <p role="alert">{m.mod_error_confirm()}</p>}
        </Form>
        {loaderData.next !== "/" && <p><Link to={loaderData.next} className="link-ui">{m.stance_consent_back()}</Link></p>}
      </section>
      <section id="privacy" className="space-y-2 rounded border p-3">
        <h2 className="text-lg font-semibold">{m.stance_privacy_title()}</h2>
        <p>{m.stance_privacy_p1()}</p>
        <p>{m.stance_privacy_p2()}</p>
        <p>{m.stance_privacy_review()}</p>
        <p>{m.stance_privacy_insightful()}</p>
        <p>{policyCopy.stanceDisclosure}</p>
        <p>{m.stance_privacy_p5()}</p>
        <p>{m.stance_privacy_p6()}</p>
      </section>
      {deleted && (
        <p role="status" className="text-success">
          {m.settings_stances_deleted()}
        </p>
      )}
      {records.length === 0 && <p>{m.settings_stances_empty()}</p>}
      <ul className="space-y-4">
        {records.map((r) => (
          <li key={r.questionId} id={`q-${r.questionId}`} className="space-y-2 rounded border p-3">
            <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 text-sm"><Checkbox checked={selected.has(r.questionId)} onCheckedChange={checked => { setSelected(previous => { const next = new Set(previous); if (checked) next.add(r.questionId); else next.delete(r.questionId); return next; }); setCopyState("idle"); }} /> {m.stances_copy_select()}</FieldLabel></Field>
            <p className="font-semibold">
              {r.state === "deleted" ? (
                m.settings_stances_question_deleted()
              ) : r.title ? (
                <Link to={`/t/${r.questionId}`} dir="auto" lang={r.title.lang} className="link-ui">
                  {r.title.text}
                </Link>
              ) : (
                m.settings_stances_question_hidden()
              )}
            </p>
            <p>{r.position === null ? m.settings_stances_now_none() : m.settings_stances_now({ position: positionLabel(r.position) })}</p>
            <div>
              <h3 className="text-sm font-semibold">{m.settings_stances_history()}</h3>
              <ol className="space-y-1 ui-meta">
                {r.changes.map((c, i) => (
                  <li key={i} className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span><time dateTime={c.at.replace(" ", "T") + "Z"}>{c.at}</time> (UTC)</span>{" "}<span>{maybeLabel(c.from)} → {maybeLabel(c.to)}</span>
                    {c.trigger &&
                      (c.trigger.href ? (
                        <>
                          {" "}
                          <Link to={c.trigger.href} className="link-ui">
                            {m.settings_stances_trigger()}
                          </Link>
                        </>
                      ) : (
                        <>{" "}<span>{m.settings_stances_trigger_unreadable()}</span></>
                      ))}
                  </li>
                ))}
              </ol>
            </div>
            <Form method="post" className="flex flex-wrap items-center gap-3 border-t pt-2 text-sm">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="questionId" value={r.questionId} />
              <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel >
                <Checkbox name="confirm" value="1" /> {m.settings_stances_delete_confirm()}
              </FieldLabel></Field>
              <Button type="submit" variant="destructive">
                {m.settings_stances_delete()}
              </Button>
              {actionData?.error === "confirm_required" && actionData.questionId === r.questionId && (
                <span role="alert" className="ui-help text-destructive">
                  {m.mod_error_confirm()}
                </span>
              )}
            </Form>
          </li>
        ))}
      </ul>
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
