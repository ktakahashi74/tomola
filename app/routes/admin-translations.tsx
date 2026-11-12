import { MarkdownBusyError, withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/admin-translations";
import { TranslationLabel } from "~/components/translation-label";
import { requireModerator } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { formString } from "~/lib/entry-form.server";
import { LANG_LABELS } from "~/lib/languages";
import { normalizeNewlines } from "~/lib/text";
import { dismissReport, listOpenReports, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { parseId } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

// Visible to operators and moderators; 404 for other members. Operators see every report; moderators see only reports for their assigned target languages.
// Review open mistranslation reports and save corrections as kind = human, resolving the reports. Pass through the requireWriter gate.
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { db, scope } = await requireModerator(request);
  return { reports: await listOpenReports(db, { scope, now: new Date() }) };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db, scope } = await requireModerator(request);
  const form = await request.formData();
  const reportId = parseId(formString(form, "reportId"));
  if (formString(form, "intent") === "dismiss") {
    await dismissReport(db, user.id, reportId, { scope });
    throw redirect("/admin/translations");
  }
  let res;
  try { res = await resolveReportWithHumanTranslation(db, user.id, reportId, normalizeNewlines(formString(form, "text")), { scope }); }
  catch (error) {
    if (!(error instanceof MarkdownBusyError)) throw error;
    return data({ error: "rate_limited" as const, reportId, text: formString(form, "text") }, { status: 503, headers: { "Retry-After": "1" } });
  }
  if (res.ok) throw redirect("/admin/translations");
  if (res.error === "not_found") throw redirect("/admin/translations");
  if (res.error === "forbidden") throw data("Forbidden", { status: 403 });
  return data({ error: res.error, reportId }, { status: 400 });
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.admin_translations_title() }];
}

export default function AdminTranslations({ loaderData, actionData }: Route.ComponentProps) {
  const { reports } = loaderData;
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold">{m.admin_translations_title()}</h1>
      {reports.length === 0 && <p>{m.admin_translations_empty()}</p>}
      {reports.map((r) => (
        <section key={r.id} id={`r-${r.id}`} className="space-y-3 rounded border p-4">
          <div className="ui-meta text-muted-foreground">
            {m.admin_report_meta({ id: r.id, handle: r.reporterHandle, date: r.createdAt.toISOString().slice(0, 10) })} ·{" "}
            {LANG_LABELS[r.lang]} · {r.field === "title" ? m.report_field_title() : m.report_field_body()} ·{" "}
            <Link to={`/t/${r.threadId}?lang=${r.lang}#${r.entryKind === "topic" ? "p" : "c"}-${r.entryId}`} className="underline">
              {m.admin_report_open()}
            </Link>
          </div>
          {r.excerpt && (
            <p>
              <span className="font-semibold">{m.admin_report_excerpt()}</span> <span lang={r.lang}>{r.excerpt}</span>
            </p>
          )}
          {r.note && (
            <p>
              <span className="font-semibold">{m.admin_report_note()}</span> {r.note}
            </p>
          )}
          <details>
            <summary className="cursor-pointer ui-meta">
              {m.admin_report_original()} · {LANG_LABELS[r.entryLang]}
            </summary>
            <pre lang={r.entryLang} className="mt-2 whitespace-pre-wrap font-sans text-sm">
              {r.field === "title" ? r.original.title : r.original.body}
            </pre>
          </details>
          {r.waitingForRetry && (
            <p role="note" className="ui-help text-notice-muted">
              {m.admin_report_waiting_retry()}
            </p>
          )}
          {r.current && (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 ui-meta font-semibold">
                {m.admin_report_current()} <TranslationLabel kind={r.current.kind} engine={r.current.engine} model={r.current.model} fallback={r.current.fallback} stale={r.current.stale} />
              </div>
              {r.current.retried && <p className="ui-help text-notice-muted">{m.admin_report_retried_note()}</p>}
            </div>
          )}
          <Form method="post" className="space-y-2">
            <input type="hidden" name="reportId" value={r.id} />
            <Field className="min-w-0 w-auto"><FieldLabel className="block">
              {m.admin_report_human()} ({LANG_LABELS[r.lang]})
              <Textarea name="text" required lang={r.lang} rows={r.field === "title" ? 2 : 10} defaultValue={actionData?.reportId === r.id && "text" in actionData ? actionData.text : r.current?.text ?? ""} className="block w-full font-mono" />
            </FieldLabel></Field>
            {actionData?.reportId === r.id && <p className="text-destructive">{actionData.error === "body_too_complex" ? m.error_body_too_complex() : actionData.error === "rate_limited" ? m.error_rate_limited() : m.admin_report_error()}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit">
                {m.admin_report_resolve()}
              </Button>
              <Button type="submit" name="intent" value="dismiss" formNoValidate variant="outline">
                {m.admin_report_dismiss()}
              </Button>
            </div>
          </Form>
        </section>
      ))}
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
