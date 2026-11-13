import { pendingNushiReports } from "~/lib/nushi-reports.server";
import { DisplayNameEvidence } from "~/components/display-name-evidence";
import { AvatarModerationCard } from "~/components/avatar-moderation-card";
import { moderateAvatar } from "~/lib/avatar-moderation.server";
import { moderateDisplayName } from "~/lib/display-name-moderation.server";
import { parseIdOrNull } from "~/lib/params.server";
import { AiReportAssessment } from "~/components/ai-report-assessment";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { VillageModerationCard } from "~/components/village-moderation";
import { moderateVillage, type VillageModerationError } from "~/lib/village-moderation.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { data, Form, Link, redirect, useLocation } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/mod";
import { Pagination } from "~/components/pagination";
import { reasonLabel } from "~/components/reason-label";
import { requireModerator } from "~/lib/auth/session.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { LANG_LABELS } from "~/lib/languages";
import { REPORT_REASONS } from "~/lib/moderation";
import { errorText } from "~/lib/mod-error-text";
import { deleteEntry, dismissReports, excludeReactions, hideEntry, includeReactions, listReportCards, MAX_SUSPEND_DAYS, suspendMember, unhideEntry, unsuspendMember, type ModerationError } from "~/lib/moderation.server";
import { parsePage } from "~/lib/params.server";
import { listUnicodeReviewCandidates, parseUnicodeReviewCursor } from "~/lib/unicode-review-list.server";
import { UNICODE_REVIEW_DAYS, UNICODE_REVIEW_SCAN_LIMIT } from "~/lib/unicode-review";
import { m } from "~/paraglide/messages.js";
import { villageName } from "~/lib/village-name";
import { deleteMediaWithLog } from "~/lib/media-store.server";
import { parseMediaPath } from "~/lib/media";

// Moderator/operator screen for open post reports in assigned languages (operators: all languages), with moderation actions.
// This route's action handles hiding, unhiding, and dismissing reports, including submissions from thread moderation controls with returnTo.
// Do not show reporters. Posts outside assigned languages are neither displayed nor actionable.
export function meta({}: Route.MetaArgs) {
  return [{ title: m.mod_title() }];
}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // Error actions normally skip loader revalidation. A stale village form must
  // receive current metadata and a matching version before it can be resubmitted.
  return actionResult?.error === "stale" ? true : defaultShouldRevalidate;
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { user, db, scope } = await requireModerator(request);
  await enforceMemberLimit(db, "mod", user.id);
  const nushi = scope.operator ? await pendingNushiReports(db) : null;
  const params = new URL(request.url).searchParams;
  const tab = params.get("tab") === "handled" ? "handled" : params.get("tab") === "review" ? "review" : "open";
  // Posts with format characters to check: a read-only list that is not saved. It stands apart from the report cards.
  if (tab === "review") {
    const review = await listUnicodeReviewCandidates(db, scope, { viewerId: user.id, cursor: parseUnicodeReviewCursor(params.get("cursor")) });
    return { nushi, tab, operator: scope.operator, maxDays: 0, cards: [], page: 1, hasNext: false, review };
  }
  // Hide reports against the viewer's own posts, which they may not moderate.
  const result = await listReportCards(db, scope, { page: parsePage(request), handled: tab === "handled", viewerId: user.id });
  return {
    review: null,
    nushi,
    tab,
    operator: scope.operator,
    maxDays: scope.operator ? MAX_SUSPEND_DAYS.operator : MAX_SUSPEND_DAYS.moderator,
    cards: result.cards.map((c) => c.kind === "avatar" ? { ...c, reports: c.reports.map(r => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })) } : c.kind === "display_name" ? { ...c, reports: c.reports.map(r => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })) } : c.kind === "village" ? { ...c, reports: c.reports.map(r => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })) } : c.kind === "chat" ? { ...c, reports: c.reports.map(r => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })) } : ({
      ...c,
      authorSuspendedUntil: c.authorSuspendedUntil ? c.authorSuspendedUntil.toISOString().slice(0, 10) : null,
      reports: c.reports.map((r) => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })),
    })),
    page: result.page,
    hasNext: result.hasNext,
  };
}

export async function action({ request }: Pick<Route.ActionArgs, "request">) {
  // Reject changes from cross-site POSTs (CSRF), checking before authentication or input parsing (csrf.server.ts convention).
  assertSameOrigin(request);
  const { user, db, scope } = await requireModerator(request);
  await enforceMemberLimit(db, "mod", user.id);
  const form = await request.formData();
  const intent = formString(form, "intent");
  const actor = { id: user.id, scope };
  const reason = formString(form, "reason");
  const note = formString(form, "note");
  // Return destinations must be same-site paths; default to /mod.
  const back = safeLocalPath(formString(form, "returnTo"));
  const done = () => redirect(back === "/" ? "/mod" : back);
  const fail = (error: VillageModerationError, id: number | string) => data({ error, id }, { status: error === "forbidden" ? 403 : error === "stale" ? 409 : 400 });
  if (intent === "clear-avatar" || intent === "dismiss-avatar") {
    const reportId = parseIdOrNull(formString(form, "reportId"));
    if (reportId === null) throw data("Bad request", { status: 400 });
    const res = await moderateAvatar(db, actor, { userId: formString(form, "userId"), reportId, version: formString(form, "avatarVersion"), dismiss: intent === "dismiss-avatar", reason, note });
    if (res.ok) throw done();
    return fail(res.error, reportId);
  }
  if (intent === "clear-display-name" || intent === "dismiss-display-name") {
    const reportId = parseIdOrNull(formString(form, "reportId"));
    if (reportId === null) throw data("Bad request", { status: 400 });
    const res = await moderateDisplayName(db, actor, { userId: formString(form, "userId"), reportId, version: formString(form, "displayNamesVersion"), dismiss: intent === "dismiss-display-name", reason, note });
    if (res.ok) throw done();
    return fail(res.error, reportId);
  }
  if (intent === "delete-media") {
    if (!scope.operator) throw data("Forbidden", { status: 403 });
    if (form.get("confirm") !== "1") return data({ error: "confirm_required" as const, id: "media" }, { status: 400 });
    const raw = formString(form, "mediaId").trim();
    let id = raw;
    if (!/^[a-f0-9]{64}$/.test(id)) {
      try { id = parseMediaPath(new URL(raw, request.url).pathname)?.id ?? ""; } catch { id = ""; }
    }
    if (!/^[a-f0-9]{64}$/.test(id)) throw data("Bad request", { status: 400 });
    const result = await deleteMediaWithLog(db, actor, { id, reason, note });
    if (!result.ok) return data({ error: result.error, id: "media" }, { status: result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : 400 });
    throw done();
  }
  if (intent === "village-fix" || intent === "village-end" || intent === "village-dismiss" || intent === "village-clear-icon") {
    const rawReport = formString(form, "reportId");
    const reportId = rawReport ? parseIdOrNull(rawReport) : undefined;
    const slugTarget = formString(form, "slugTarget");
    if (reportId === null || reportId === undefined && !slugTarget) throw data("Bad request", { status: 400 });
    if (intent === "village-end" && formString(form, "confirm") !== "1") return data({ error: "confirm_required" as const, id: reportId ?? slugTarget }, { status: 400 });
    const res = await moderateVillage(db, actor, { ...(reportId === undefined ? { slugTarget } : { reportId }), version: formString(form, "villageVersion"), intent: intent === "village-clear-icon" ? "clear-icon" : intent === "village-fix" ? "fix" : intent === "village-end" ? "end" : "dismiss", reason, note,
      ...(form.has("name") ? { name: formString(form, "name") } : {}), ...(form.has("slug") ? { slug: formString(form, "slug") } : {}), ...(form.has("description") ? { description: formString(form, "description") } : {}) });
    if (res.ok) throw done();
    return fail(res.error, reportId ?? slugTarget);
  }
  // Member actions: suspend or unsuspend using reportId. Operators may also act without a report.
  if (intent === "suspend" || intent === "unsuspend") {
    const userId = formString(form, "userId");
    // The server selects a report associated with entryId for the action; the UI does not choose a single report.
    const entryRaw = formString(form, "entryId");
    const entryId = parseIdOrNull(entryRaw);
    if (userId === "") throw data("Bad request", { status: 400 });
    const res =
      intent === "suspend"
        ? await suspendMember(db, actor, { userId, entryId, reason, note, days: formString(form, "days") })
        : await unsuspendMember(db, actor, { userId, entryId, reason, note });
    if (res.ok) throw done();
    return fail(res.error, userId);
  }
  // Exclude stances and 「なるほど」 from counts, or revoke that exclusion. Operators only, checked by the function; submitted from /admin/roles.
  if (intent === "exclude-reactions" || intent === "include-reactions") {
    const userId = formString(form, "userId");
    if (userId === "") throw data("Bad request", { status: 400 });
    const res = intent === "exclude-reactions" ? await excludeReactions(db, actor, { userId, reason, note }) : await includeReactions(db, actor, { userId, reason, note });
    if (res.ok) throw done();
    return fail(res.error, userId);
  }
  const entryId = parseIdOrNull(formString(form, "entryId"));
  if (entryId === null) throw data("Bad request", { status: 400 });
  const input = { entryId, reason, note };
  // Deletion is operator-only. Require the confirmation checkbox server-side as well as in the UI.
  if (intent === "delete" && formString(form, "confirm") !== "1") return data({ error: "confirm_required" as const, id: entryId }, { status: 400 });
  const res =
    intent === "delete"
      ? await deleteEntry(db, actor, input)
      : intent === "hide"
        ? await hideEntry(db, actor, input)
        : intent === "unhide"
          ? await unhideEntry(db, actor, input)
          : intent === "dismiss"
            ? await dismissReports(db, actor, input)
            : null;
  if (res === null) throw data("Bad request", { status: 400 });
  if (res.ok) throw done();
  return fail(res.error, entryId);
}

export default function Mod({ loaderData, actionData }: Route.ComponentProps) {
  const { tab, cards, page, hasNext, maxDays, operator, review, nushi } = loaderData;
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}`;
  return (
    <main className="space-y-6">
      {nushi && <section aria-label={m.nushi_reports()} className="space-y-2">
        <Link to="/nushi/reports" className="underline">{m.nushi_reports()} ({nushi.count})</Link>
        {tab === "open" && nushi.reports.map(report => <article key={report.id} className="rounded border p-3">
          <Link to={`/nushi/${report.answerId}`} className="underline">{m.nushi_name()} #{report.answerId}</Link>
          <p>{reasonLabel(report.reason)} · {report.note}</p>
          <Link to={`/nushi/reports?report=${report.id}#nushi-report-${report.id}`} className="underline">{m.nushi_reports()}</Link>
        </article>)}
      </section>}
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-2xl font-bold">{m.mod_title()}</h1>
        <Link to="/mod" className={tab === "open" ? "font-semibold underline" : "underline"}>
          {m.mod_tab_open()}
        </Link>
        <Link to="/mod?tab=handled" className={tab === "handled" ? "font-semibold underline" : "underline"}>
          {m.mod_tab_handled()}
        </Link>
        <Link to="/mod?tab=review" className={tab === "review" ? "font-semibold underline" : "underline"}>
          {m.mod_tab_review()}
        </Link>
        <Link to="/mod/appeals" className="underline">
          {m.mod_appeals_link()}
        </Link>
        <Link className="underline" to="/mod/chat-translations">{m.chat_translation_reports_title()}</Link>
      </div>
      {actionData?.error && (
        <p role="alert" className="text-destructive">
          {errorText(actionData.error)}
        </p>
      )}
      {review && <section aria-labelledby="mod-review-heading" className="space-y-3">
        <h2 id="mod-review-heading" className="sr-only">{m.mod_tab_review()}</h2>
        <p className="ui-help text-muted-foreground">{m.mod_review_intro({ days: UNICODE_REVIEW_DAYS })}</p>
        {review.items.length === 0 && <p>{m.mod_review_empty()}</p>}
        <ul className="space-y-2">
          {review.items.map((item) => <li key={item.entryId} className="flex flex-wrap items-center gap-x-2 rounded border p-3 ui-meta">
            <span lang={item.lang}>{item.lang === "other" ? m.source_language_other() : LANG_LABELS[item.lang]}</span>
            <span>· {item.kind === "topic" ? m.mod_kind_topic() : m.mod_kind_reply()}</span>
            <Link to={`/t/${item.threadId}#${item.kind === "topic" ? "p" : "c"}-${item.entryId}`} className="underline">{m.mod_open_in_thread()}</Link>
            {item.counts.bidi_control !== undefined && <span>· {m.mod_review_reason_bidi_control({ count: item.counts.bidi_control })}</span>}
            {item.counts.tag_characters !== undefined && <span>· {m.mod_review_reason_tag_characters({ count: item.counts.tag_characters })}</span>}
          </li>)}
        </ul>
        {review.scanLimited && <p role="status">{m.mod_review_scan_limited({ count: UNICODE_REVIEW_SCAN_LIMIT })}</p>}
        {review.cursor && <Link className="underline" to={`/mod?tab=review&cursor=${encodeURIComponent(review.cursor)}`}>{m.mod_review_continue()}</Link>}
      </section>}
      {!review && cards.length === 0 && (tab !== "open" || !nushi?.count) && <p>{tab === "open" ? m.mod_empty() : m.mod_empty_handled()}</p>}
      {cards.map((c) => c.kind === "avatar" ? <AvatarModerationCard key={`avatar-${c.userId}`} card={c} handled={tab === "handled"} returnTo={returnTo} /> : c.kind === "display_name" ? <section key={`name-${c.userId}`} className="space-y-2 rounded border p-4">
        <p><Link to={`/u/${c.handle}`} className="underline">@{c.handle}</Link></p>
        <h3>{m.display_name_current()}</h3>
        <DisplayNameEvidence names={c} />
        {c.reports.map(report => <div key={report.id}><h3>{m.display_name_reported()}</h3>{report.names && <DisplayNameEvidence names={report.names} />}<p>{reasonLabel(report.reason)} · {report.createdAt}</p><p className="whitespace-pre-wrap">{report.note}</p></div>)}
        {tab === "open" && <Form method="post" className="space-y-2">
          <input type="hidden" name="userId" value={c.userId} /><input type="hidden" name="reportId" value={c.reports[0].id} />
          <input type="hidden" name="displayNamesVersion" value={c.version} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <Field><FieldLabel>{m.mod_reason()}<select name="reason" defaultValue={c.reports[0].reason}>{REPORT_REASONS.map(reason => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}</select></FieldLabel></Field>
          <Field><FieldLabel>{m.mod_note()}<Textarea name="note" maxLength={500} /></FieldLabel></Field>
          <div className="flex flex-wrap gap-2"><Button type="submit" name="intent" value="clear-display-name" variant="outline">{m.display_name_clear()}</Button><Button type="submit" name="intent" value="dismiss-display-name" variant="outline">{m.mod_dismiss()}</Button></div>
        </Form>}
      </section> : c.kind === "chat" ? <section key={`chat-${c.reportId}`} className="space-y-2 rounded border p-4">
        <p className="font-semibold">{m.mod_kind_chat()} · {LANG_LABELS[c.lang]} {c.village && villageName(c.village)}</p>
        {c.reports.map(report => <div key={report.id}><p>{reasonLabel(report.reason)} · {report.note}</p>{report.automaticallyResolved && <p>{m.moderation_automatic()}</p>}<AiReportAssessment report={report} priorityOnly /></div>)}
        <p>{m.chat_report_count({ count: c.reports.length })}</p>
        {tab === "open" && <Link className="underline" to={`/mod/chat/report/${c.reportId}`}>{m.chat_reports_open()}</Link>}
        {tab === "handled" && c.canUnhide && <Link className="underline" to={`/mod/chat/report/${c.reportId}`}>{m.chat_reports_manage_closed()}</Link>}
      </section> : c.kind === "village" ? <VillageModerationCard key={`v-${c.reportId}`} card={c} handled={tab === "handled"} returnTo={returnTo} /> : (
        <section key={c.entryId} id={`e-${c.entryId}`} className="space-y-3 rounded border p-4">
          <div className="flex flex-wrap items-center gap-x-2 ui-meta text-muted-foreground">
            <span lang={c.lang}>{c.lang === "other" ? m.source_language_other() : LANG_LABELS[c.lang]}</span>
            <span>· {c.kind === "topic" ? m.mod_kind_topic() : m.mod_kind_reply()}</span>
            <span>· @{c.authorHandle}</span>
            {c.hidden && <span className="rounded bg-notice px-1.5 py-0.5 ui-meta text-notice-foreground">{m.entry_hidden_mark()}</span>}
            {c.kind === "topic" && <Link className="underline" to={`/t/${c.entryId}/ai-materials`}>{m.ai_material_title()}</Link>}
            <Link to={`/t/${c.threadId}#${c.kind === "topic" ? "p" : "c"}-${c.entryId}`} className="underline">
              {m.mod_open_in_thread()}
            </Link>
          </div>
          {c.title && (
            <p lang={c.lang} className="font-semibold">
              {c.title}
            </p>
          )}
          <pre lang={c.lang} className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm">
            {c.body}
          </pre>
          <ul className="space-y-1 text-sm">
            {c.reports.map((r) => (
              <li key={r.id}>
                <span className="ui-meta font-semibold">{reasonLabel(r.reason)}</span> <span className="ui-meta text-muted-foreground">({r.createdAt})</span>
                {r.note && <span> — {r.note}</span>}
                {r.automaticallyResolved && <p>{m.moderation_automatic()}</p>}
                <AiReportAssessment report={r} />
              </li>
            ))}
          </ul>
          <Form method="post" className="space-y-2">
            <input type="hidden" name="entryId" value={c.entryId} />
            <input type="hidden" name="userId" value={c.authorId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <div className="flex flex-wrap items-end gap-3">
              <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
                {m.mod_reason()}
                <Select name="reason" defaultValue={c.reports[0]?.reason ?? "other"} items={[...REPORT_REASONS.map((r) => (
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
              <Field className="min-w-0 w-auto"><FieldLabel className="block flex-1 text-sm">
                {m.mod_note()}
                <Textarea name="note" rows={2} maxLength={500} className="block w-full" />
              </FieldLabel></Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {c.hidden ? (
                <Button type="submit" name="intent" value="unhide" variant="outline">
                  {m.mod_unhide()}
                </Button>
              ) : (
                <Button type="submit" name="intent" value="hide">
                  {m.mod_hide()}
                </Button>
              )}
              {tab === "open" && (
                <Button type="submit" name="intent" value="dismiss" variant="outline">
                  {m.mod_dismiss()}
                </Button>
              )}
            </div>
            {operator && (
              <div className="flex flex-wrap items-center gap-3 border-t pt-2">
                <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 text-sm">
                  <Checkbox name="confirm" value="1" /> {m.mod_delete_confirm()}
                </FieldLabel></Field>
                <Button type="submit" name="intent" value="delete" variant="destructive">
                  {m.mod_delete()}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3 border-t pt-2">
              {c.authorSuspendedUntil ? (
                <>
                  <span className="ui-meta">{m.mod_author_suspended({ until: c.authorSuspendedUntil })}</span>
                  <Button type="submit" name="intent" value="unsuspend" variant="outline">
                    {m.mod_unsuspend()}
                  </Button>
                </>
              ) : (
                <>
                  <Field className="min-w-0 w-auto"><FieldLabel className="block text-sm">
                    {m.mod_days({ max: maxDays })}
                    <Input name="days" type="number" min={1} max={maxDays} defaultValue={7} className="block w-24" />
                  </FieldLabel></Field>
                  <Button type="submit" name="intent" value="suspend" variant="destructive">
                    {m.mod_suspend()}
                  </Button>
                </>
              )}
            </div>
          </Form>
        </section>
      ))}
      {!review && <Pagination page={page} hasNext={hasNext} />}
      {operator && <details open={actionData?.id === "media"} className="space-y-2 rounded border p-3">
        {/* An operator's tool that is not about the reports above: one line at the foot until it is needed. */}
        <summary className="cursor-pointer text-lg font-semibold">{m.moderation_media_heading()}</summary>
        {actionData?.id === "media" && <p role="alert">{errorText(actionData.error)}</p>}
        <Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="delete-media" />
          <label className="block">{m.moderation_media_id()}<Input name="mediaId" required /></label>
          <label className="block">{m.mod_reason()}<select name="reason" required className="block rounded border p-2">{REPORT_REASONS.map(reason => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}</select></label>
          <label className="block">{m.mod_note()}<Textarea name="note" required maxLength={1500} /></label>
          <label className="flex gap-2"><input type="checkbox" name="confirm" value="1" required />{m.media_delete_confirm()}</label>
          <Button type="submit" variant="destructive">{m.media_delete()}</Button>
        </Form>
      </details>}
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
