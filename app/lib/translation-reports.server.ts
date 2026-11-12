import { completeTranslationReports } from "./translation-report-results.server";
import { lockReviewableEntry, rootTopic, rootTopicOn, reviewableWithTopic } from "./visibility.server";
import { checkBodyBudget } from "./markdown.server";
import { withMarkdownScope, MarkdownBudgetError } from "./markdown-budget.server";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, translationReports, translations } from "~/lib/db/schema";
import { isStale, pickTranslation, SHOWN_KINDS, type ShownKind } from "~/lib/display";
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH, tryRenderTranslationHtml } from "~/lib/entries.server";
import { isEnabledLang } from "~/lib/enabled-langs.server";
import { enqueue } from "~/lib/jobs/queue.server";
import { LANGS, type Lang } from "~/lib/languages";
import { FLAG_RETRIED_AFTER_REPORT } from "~/lib/llm/flags";
import { isRetryConfigured, type LlmOptions } from "~/lib/llm/index.server";
import { currentRetryCaps } from "~/lib/llm/retry-caps.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { resolveSourceMentions } from "~/lib/mentions.server";
import { inLanguageScope, type ModScope } from "~/lib/roles.server";
import { recordRevision } from "~/lib/translation-revisions.server";
import { firstSeenAtForSource } from "~/lib/translation-first-seen.server";
import { RETRANSLATE_REPORT_JOB, retranslateDedupeKey, TRANSLATE_MAX_ATTEMPTS, type RetranslateReportPayload } from "~/lib/translations.server";

// Mistranslation reports and operator corrections (kind = human translations).
// Reports use translation_reports (status: open | resolved). One-click reporting; excerpt and note are optional. Routes:
//     - retry: the first report for a (post, language, field, source version). While awaiting stronger-model automatic retranslation (retranslate_after_report in jobs/translation-jobs.server.ts),
//         omit it from the moderator queue. A unique DB index on the retry slot (retry_slot),
//         translation_reports_retry_once_idx, atomically chooses the first report. Once used, the slot remains occupied even if the route changes to moderator, preventing another expensive retry after failure or skipping.
//     - moderator (default): reports after retranslation, reports with no retry target (a displayed human correction, no current-version machine translation, or no retry model), failed retries,
//         and reports after the daily automatic retranslation limits (per member and site-wide; TRANSLATION_RETRY_MEMBER_DAILY_MAX and TRANSLATION_RETRY_DAILY_MAX) are reached.
//         Show in /admin/translations and handle through the existing correction path (resolveReportWithHumanTranslation, dismissReport).
// An operator's human correction resolves all open reports for the same (post, language, field).
// Retranslation does not overwrite human corrections until the source is edited (primary retranslation writes only kind = primary rows; source edits mark human translations stale).
// Show a small notice to other readers on reported translations (loadReportNotices).

// Time before a pending automatic retry (route = retry) becomes visible in the moderator queue with a note. This prevents invisible reports if the job's final attempt fails outside the queue
// (database failure, deadlock, or recovery of a stalled job), leaving route = retry, or if budget degradation or suspension leaves the job queued for days.
export const RETRY_VISIBLE_AFTER_MS = 30 * 60 * 1000;

export const MAX_EXCERPT_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 2000;

export type ReportError = "not_found" | "invalid_lang" | "invalid_field" | "too_long";

const reportSchema = z.object({
  lang: z.enum(LANGS),
  // Default field is body (title reports apply only to topics).
  field: z.enum(["title", "body"]),
  excerpt: z.string().trim().max(MAX_EXCERPT_LENGTH),
  note: z.string().trim().max(MAX_NOTE_LENGTH),
});

export type CreateReportResult =
  // Null id and route: a duplicate click created no row, preserving the first-report slot.
  | { ok: true; id: number | null; route: "retry" | "moderator" | null }
  | { ok: false; error: ReportError };

// Report a mistranslation. Any member may report a non-source-language translation of an undeleted, unhidden post (title reports only for topics). Excerpt and note are optional.
// If this member already has an open report for the same (post, language, field) and the new report has neither excerpt nor note, return success without creating another row.
// opts.llm: configuration for deciding whether a retry model is available (isRetryConfigured). Tests pass environment variables or engines; otherwise use process.env.
export async function createTranslationReport(
  db: Db,
  reporterId: string,
  input: { entryId: number; lang: unknown; field?: unknown; excerpt?: unknown; note?: unknown },
  opts: { now?: Date; llm?: LlmOptions } = {},
): Promise<CreateReportResult> {
  return db.transaction(async (tx): Promise<CreateReportResult> => {
    const entry = await lockReviewableEntry(tx, input.entryId);
    if (!entry) return { ok: false, error: "not_found" };
    const rawField = typeof input.field === "string" && input.field.trim() !== "" ? input.field : input.field === undefined || input.field === null || input.field === "" ? "body" : input.field;
    const parsed = reportSchema.safeParse({ lang: input.lang, field: rawField, excerpt: String(input.excerpt ?? ""), note: String(input.note ?? "") });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      if (field === "lang") return { ok: false, error: "invalid_lang" };
      if (field === "field") return { ok: false, error: "invalid_field" };
      return { ok: false, error: "too_long" };
    }
    const { lang, field, excerpt, note } = parsed.data;
    // A translation can be reported only into a language that is enabled (ENABLED_LANGS): a translation into another language is never shown, and a report for it would leave a
    // moderator item for a language nobody moderates (or, with an old row of a closed language, start a paid automatic re-translation there).
    if (lang === entry.lang || !isEnabledLang(lang)) return { ok: false, error: "invalid_lang" };
    // Only a topic that has a title has a translated title to report (a topic without a title is shown by the translation of its body).
    if (field === "title" && (entry.kind !== "topic" || entry.title === null)) return { ok: false, error: "invalid_field" };
    // Posts with no source version have no retry target (moderator).
    const sourceHash = entry.sourceHash;
    const retryConfigured = isRetryConfigured(opts.llm);

    if (excerpt === "" && note === "") {
      // Serialize duplicate one-click reports by a member for a (post, language, field) with an advisory lock; the later request checks after the earlier one commits.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`translation-report:${reporterId}:${entry.id}:${lang}:${field}`}, 0))`);
      const [again] = await tx
        .select({ id: translationReports.id })
        .from(translationReports)
        .where(
          and(
            eq(translationReports.entryId, entry.id),
            eq(translationReports.lang, lang),
            eq(translationReports.field, field),
            eq(translationReports.reporterId, reporterId),
            eq(translationReports.status, "open"),
          ),
        )
        .limit(1);
      if (again) return { ok: true as const, id: null, route: null };
    }
    const base = { entryId: entry.id, sourceLang: entry.lang, lang, field, reporterId, excerpt, note, sourceHash, createdAt: opts.now };

    // Retry eligibility: the displayed field must be a current-version machine translation (primary). A human correction or no current machine translation leaves no retry target.
    let retryable = false;
    if (retryConfigured && sourceHash !== null) {
      const rows = await tx
        .select({ kind: translations.kind, sourceHash: translations.sourceHash, flags: translations.flags })
        .from(translations)
        .where(and(eq(translations.entryId, entry.id), eq(translations.lang, lang), eq(translations.field, field), inArray(translations.kind, [...SHOWN_KINDS])));
      retryable = pickTranslation(rows, sourceHash)?.kind === "primary";
    }
    if (retryable && sourceHash !== null && (await withinRetryCaps(tx, reporterId, opts.now ?? new Date(), currentRetryCaps(opts.llm?.env ?? process.env)))) {
      // First report: insert against the unique retry_slot index. If another first report wins and insertion returns no row, retry insertion with route moderator.
      const [first] = await tx
        .insert(translationReports)
        .values({ ...base, sourceHash, route: "retry", retrySlot: true })
        .onConflictDoNothing({ target: [translationReports.entryId, translationReports.lang, translationReports.field, translationReports.sourceHash], where: sql`${translationReports.retrySlot}` })
        .returning({ id: translationReports.id });
      if (first) {
        const payload: RetranslateReportPayload = { reportId: first.id, entryId: entry.id };
        await enqueue(tx, RETRANSLATE_REPORT_JOB, payload, { dedupeKey: retranslateDedupeKey(first.id), maxAttempts: TRANSLATE_MAX_ATTEMPTS });
        return { ok: true as const, id: first.id, route: "retry" as const };
      }
    }
    const [row] = await tx.insert(translationReports).values({ ...base, route: "moderator" }).returning({ id: translationReports.id });
    return { ok: true as const, id: row.id, route: "moderator" as const };
  });
}

// Check daily automatic retry limits: slots used by this member and across the site in the preceding 24 hours must both be below their limits. Serialize first reports with an advisory lock while counting slots
// to prevent simultaneous reports exceeding the limits. Count rows with retry_slot true even after their route changes to moderator: they represent stronger-model calls made or planned.
async function withinRetryCaps(tx: Db, reporterId: string, now: Date, caps: { perMember: number; total: number }): Promise<boolean> {
  if (caps.perMember <= 0 || caps.total <= 0) return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('translation-retry-cap', 0))`);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [counts] = await tx
    .select({
      member: sql<number>`(count(*) filter (where ${translationReports.reporterId} = ${reporterId}))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(translationReports)
    .where(and(eq(translationReports.retrySlot, true), gte(translationReports.createdAt, since)));
  return counts.member < caps.perMember && counts.total < caps.total;
}

export type ReportNotice = "open" | "retried";

// Display assembly batches lookups by (post, language). Return "open" for an open report (「この訳には指摘があります。原文も確かめてください」); otherwise return "retried" if a current machine translation field (title or body)
// has retried_after_report (「指摘を受けて訳し直しました」). A new report after retry returns it to "open". Otherwise omit the key.
// With sourceHash, count only reports and translations for that source version (do not show old-version report notices on new translations after source edits; legacy reports with null versions still count).
export async function loadReportNotices(
  db: Db,
  targets: ReadonlyArray<{ entryId: number; lang: Lang; sourceHash?: string | null }>,
): Promise<Map<string, ReportNotice>> {
  const out = new Map<string, ReportNotice>();
  if (targets.length === 0) return out;
  const entryIds = [...new Set(targets.map((t) => t.entryId))];
  const langs = [...new Set(targets.map((t) => t.lang))];
  const [open, retried] = await Promise.all([
    db
      .select({ entryId: translationReports.entryId, lang: translationReports.lang, sourceHash: translationReports.sourceHash })
      .from(translationReports)
      .innerJoin(entries, eq(entries.id, translationReports.entryId)).innerJoin(rootTopic, rootTopicOn())
      .where(and(reviewableWithTopic(), inArray(translationReports.entryId, entryIds), inArray(translationReports.lang, langs), eq(translationReports.status, "open"))),
    db
      .select({ entryId: translations.entryId, lang: translations.lang, sourceHash: translations.sourceHash })
      .from(translations)
      .innerJoin(entries, eq(entries.id, translations.entryId)).innerJoin(rootTopic, rootTopicOn())
      .where(
        and(
          reviewableWithTopic(),
          inArray(translations.entryId, entryIds),
          inArray(translations.lang, langs),
          eq(translations.kind, "primary"),
          sql`${FLAG_RETRIED_AFTER_REPORT} = any(${translations.flags})`,
        ),
      ),
  ]);
  for (const t of targets) {
    const current = (hash: string | null) => t.sourceHash === undefined || t.sourceHash === null || hash === null || hash === t.sourceHash;
    const key = reportNoticeKey(t.entryId, t.lang);
    if (open.some((r) => r.entryId === t.entryId && r.lang === t.lang && current(r.sourceHash))) out.set(key, "open");
    else if (retried.some((r) => r.entryId === t.entryId && r.lang === t.lang && t.sourceHash !== undefined && t.sourceHash !== null && r.sourceHash === t.sourceHash)) out.set(key, "retried");
    else if (t.sourceHash === undefined && retried.some((r) => r.entryId === t.entryId && r.lang === t.lang)) out.set(key, "retried");
  }
  return out;
}

export const reportNoticeKey = (entryId: number, lang: string) => `${entryId}:${lang}`;

// Only the member's open reports for the source version currently on screen.
export async function loadOwnTranslationReports(db: Db, reporterId: string, targets: readonly { id: number; sourceHash: string | null }[]) {
  if (!targets.length) return [];
  const rows = await db.select({ id: translationReports.id, entryId: translationReports.entryId, lang: translationReports.lang, field: translationReports.field, excerpt: translationReports.excerpt, note: translationReports.note, sourceHash: translationReports.sourceHash }).from(translationReports)
    .innerJoin(entries, eq(entries.id, translationReports.entryId)).innerJoin(rootTopic, rootTopicOn())
    .where(and(reviewableWithTopic(), eq(translationReports.reporterId, reporterId), eq(translationReports.status, "open"), inArray(translationReports.entryId, targets.map(target => target.id))));
  return rows.filter(row => targets.some(target => target.id === row.entryId && (row.sourceHash === null || row.sourceHash === target.sourceHash)));
}

// Adding an explanation updates the one-click report rather than creating another report or retry job.
export async function updateTranslationReportDetails(db: Db, reporterId: string, id: number, input: { entryId: number; lang: unknown; field: unknown; excerpt: unknown; note: unknown }): Promise<CreateReportResult> {
  if (!Number.isSafeInteger(id) || id < 1) return { ok: false, error: "not_found" };
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "too_long" };
  return db.transaction(async tx => {
    const entry = await lockReviewableEntry(tx, input.entryId);
    if (!entry) return { ok: false, error: "not_found" };
    const [row] = await tx.update(translationReports).set({ excerpt: parsed.data.excerpt, note: parsed.data.note }).where(and(
      eq(translationReports.id, id), eq(translationReports.reporterId, reporterId), eq(translationReports.entryId, input.entryId), eq(translationReports.lang, parsed.data.lang), eq(translationReports.field, parsed.data.field),
      eq(translationReports.status, "open"), or(isNull(translationReports.sourceHash), entry.sourceHash === null ? isNull(translationReports.sourceHash) : eq(translationReports.sourceHash, entry.sourceHash)),
    )).returning({ id: translationReports.id });
    return row ? { ok: true, id: row.id, route: null } : { ok: false, error: "not_found" };
  });
}

export type OpenReport = {
  id: number;
  entryId: number;
  threadId: number;
  entryKind: "topic" | "reply";
  entryLang: Lang;
  lang: Lang;
  field: "title" | "body";
  excerpt: string;
  note: string;
  reporterHandle: string;
  createdAt: Date;
  // Original source (titles only for topics).
  original: { title: string | null; body: string };
  // A pending automatic retry (route = retry) is now visible because its wait exceeded RETRY_VISIBLE_AFTER_MS. Once a human correction is saved, automatic retry leaves the closed report untouched.
  waitingForRetry: boolean;
  // Currently displayed translation (human > primary), or null if unavailable. retried: retranslated with a stronger model after a report (retried_after_report).
  current: { text: string; kind: ShownKind; engine: string | null; model: string | null; fallback: boolean; stale: boolean; retried: boolean } | null;
};

// Open reports, oldest first. The moderator queue includes route moderator (reports after retries and reports that could not be retried), excluding first reports awaiting automatic retry (retry),
// except those waiting longer than RETRY_VISIBLE_AFTER_MS, shown with waitingForRetry (jobs left failed or awaiting budget recovery).
// Include the source and currently displayed translation for correction.
// With scope, restrict to target languages (report lang) assigned to the moderator; operators see all. now is the time used to measure waiting duration, defaulting to the current time.
export async function listOpenReports(db: Db, opts: { scope?: ModScope; now?: Date } = {}): Promise<OpenReport[]> {
  const scope = opts.scope;
  const visibleSince = new Date((opts.now ?? new Date()).getTime() - RETRY_VISIBLE_AFTER_MS);
  if (scope && !scope.operator && scope.langs.length === 0) return [];
  const reports = await db
    .select({
      id: translationReports.id,
      entryId: translationReports.entryId,
      lang: translationReports.lang,
      field: translationReports.field,
      excerpt: translationReports.excerpt,
      note: translationReports.note,
      createdAt: translationReports.createdAt,
      route: translationReports.route,
      reporterHandle: profiles.handle,
      entryKind: entries.kind,
      entryLang: entries.lang,
      threadId: entries.threadId,
      title: entries.title,
      body: entries.body,
      sourceHash: entries.sourceHash,
    })
    .from(translationReports)
    .innerJoin(entries, eq(entries.id, translationReports.entryId))
    .innerJoin(rootTopic, rootTopicOn())
    .leftJoin(profiles, eq(profiles.userId, translationReports.reporterId))
    // Omit reports for deleted or hidden posts to withhold their content; show them again if the post is unhidden.
    .where(
      and(
        eq(translationReports.status, "open"),
        or(eq(translationReports.route, "moderator"), and(eq(translationReports.route, "retry"), lte(translationReports.createdAt, visibleSince))),
        reviewableWithTopic(),
        scope && !scope.operator ? inArray(translationReports.lang, [...scope.langs]) : undefined,
      ),
    )
    .orderBy(asc(translationReports.createdAt), asc(translationReports.id));
  if (reports.length === 0) return [];
  const rows = await db
    .select()
    .from(translations)
    .where(
      and(
        inArray(translations.entryId, [...new Set(reports.map((r) => r.entryId))]),
        inArray(translations.kind, [...SHOWN_KINDS]),
      ),
    );
  return reports.map((r) => {
    const picked = pickTranslation(
      rows.filter((t) => t.entryId === r.entryId && t.lang === r.lang && t.field === r.field),
      r.sourceHash,
    );
    return {
      id: r.id,
      entryId: r.entryId,
      threadId: r.threadId ?? r.entryId,
      entryKind: r.entryKind as "topic" | "reply",
      entryLang: r.entryLang as Lang,
      lang: r.lang as Lang,
      field: r.field as "title" | "body",
      excerpt: r.excerpt,
      note: r.note,
      reporterHandle: r.reporterHandle ?? "?",
      createdAt: r.createdAt,
      waitingForRetry: r.route === "retry",
      original: { title: r.title, body: r.body },
      current: picked
        ? { text: picked.text, kind: picked.kind, engine: picked.engine, model: picked.model, fallback: picked.fallback, stale: isStale(picked.flags), retried: picked.flags.includes(FLAG_RETRIED_AFTER_REPORT) }
        : null,
    };
  });
}

// forbidden: the target language is not assigned to this moderator.
export type ResolveError = "not_found" | "invalid_text" | "forbidden" | "body_too_complex";

// Save a human correction (kind = human) in response to a report and resolve all open reports for the same (post, language, field).
// Save against the current source without a stale flag. Return not_found for already resolved reports or deleted posts.
async function resolveReportWithHumanTranslationImplementation(
  db: Db,
  operatorId: string,
  reportId: number,
  text: unknown,
  opts: { now?: Date; scope?: ModScope } = {},
): Promise<{ ok: true; entryId: number } | { ok: false; error: ResolveError }> {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    // Always lock in order: root topic, post, then report (as with deletion cleanup and automatic retry saves; reversing the order deadlocks). First read the report without a lock, lock the post FOR UPDATE,
    // then reread the report FOR UPDATE and check it is still open (automatic retry or another human correction may have closed it while waiting).
    const [peek] = await tx
      .select({ entryId: translationReports.entryId, lang: translationReports.lang })
      .from(translationReports)
      .where(and(eq(translationReports.id, reportId), eq(translationReports.status, "open")));
    if (!peek) return { ok: false as const, error: "not_found" as const };
    // Moderators may correct only translations into their assigned languages.
    if (opts.scope && !inLanguageScope(opts.scope, peek.lang)) return { ok: false as const, error: "forbidden" as const };
    const entry = await lockReviewableEntry(tx, peek.entryId, "update");
    const [report] = await tx
      .select()
      .from(translationReports)
      .where(and(eq(translationReports.id, reportId), eq(translationReports.status, "open")))
      .for("update");
    if (!report) return { ok: false as const, error: "not_found" as const };
    if (!entry || entry.deletedAt || entry.hiddenAt) return { ok: false as const, error: "not_found" as const };
    const field = report.field as "title" | "body";
    const parsed = z
      .string()
      .max(field === "title" ? MAX_TITLE_LENGTH : MAX_BODY_LENGTH)
      .refine((s) => s.trim().length > 0)
      .safeParse(text);
    if (!parsed.success) return { ok: false as const, error: "invalid_text" as const };
    const value = field === "title" ? parsed.data.trim() : parsed.data;
    if (field === "body") {
      const bodyError = await checkBodyBudget(value, operatorId);
      if (bodyError === "body_too_complex") return { ok: false as const, error: bodyError };
    }
    // Render and cache body translations on save, not during viewing requests.
    const rendered = field === "body" ? (await tryRenderTranslationHtml(entry.kind as "topic" | "reply", report.entryId, report.lang, value, (await resolveSourceMentions(tx, entry.body, report.entryId)).targets)) : null;
    if (field === "body" && rendered === null) return { ok: false as const, error: "invalid_text" as const };
    const values = {
      text: value,
      engine: null,
      model: null,
      promptVersion: null,
      glossaryVersion: null,
      sourceHash: entry.sourceHash,
      mentionRevision: entry.mentionRevision,
      flags: [] as string[],
      createdBy: operatorId,
      html: rendered?.html ?? null,
      cardHtml: rendered?.cardHtml ?? null,
      htmlVersion: rendered === null ? 0 : RENDER_VERSION,
      updatedAt: now,
    };
    // Archive the old human correction before overwriting, unless the content is unchanged.
    const before = pickTranslation(await tx.select().from(translations).where(and(eq(translations.entryId, report.entryId), eq(translations.field, field), eq(translations.lang, report.lang), inArray(translations.kind, [...SHOWN_KINDS]))), entry.sourceHash, entry.mentionRevision);
    const correctedAt = before?.text.normalize("NFC").trim() === value.normalize("NFC").trim() ? null : now;
    await recordRevision(tx, { entryId: report.entryId, field, lang: report.lang, kind: "human" }, "human_edit", now, { text: value, engine: null, model: null, sourceHash: entry.sourceHash, fallback: false });
    await tx
      .insert(translations)
      .values({ entryId: report.entryId, field, lang: report.lang, kind: "human", ...values, createdAt: now })
      .onConflictDoUpdate({ target: [translations.entryId, translations.field, translations.lang, translations.kind], set: { ...values, firstSeenAt: firstSeenAtForSource(entry.sourceHash, entry.mentionRevision) } });
    const targets = and(eq(translationReports.entryId, report.entryId), eq(translationReports.lang, report.lang), eq(translationReports.field, report.field))!;
    // A correction of today's translation does not correct an older source revision.
    const currentVersion = entry.sourceHash === null ? isNull(translationReports.sourceHash) : eq(translationReports.sourceHash, entry.sourceHash);
    await completeTranslationReports(tx, and(targets, or(isNull(translationReports.sourceHash), currentVersion))!, correctedAt ? "human_corrected" : "unchanged", now, { resolvedBy: operatorId, correctedAt });
    await completeTranslationReports(tx, targets, "source_updated", now, { resolvedBy: operatorId, correctedAt });
    return { ok: true as const, entryId: report.entryId };
  });
}

// Close a report without changing the translation, for example when it was not a mistranslation. Resolve only this report.
// With scope, only assigned-language reports may be closed; otherwise do nothing and return false.
export async function dismissReport(db: Db, operatorId: string, reportId: number, opts: { now?: Date; scope?: ModScope } = {}): Promise<boolean> {
  return db.transaction(async tx => {
    const [peek] = await tx.select().from(translationReports).where(and(eq(translationReports.id, reportId), eq(translationReports.status, "open")));
    if (!peek || (opts.scope && !inLanguageScope(opts.scope, peek.lang))) return false;
    const entry = await lockReviewableEntry(tx, peek.entryId, "update");
    if (!entry) return false;
    const [report] = await tx.select().from(translationReports).where(and(eq(translationReports.id, reportId), eq(translationReports.status, "open"))).for("update");
    if (!report) return false;
    await completeTranslationReports(tx, eq(translationReports.id, reportId), report.sourceHash !== null && report.sourceHash !== entry.sourceHash ? "source_updated" : "unchanged", opts.now ?? new Date(), { resolvedBy: operatorId });
    return true;
  });
}

export async function resolveReportWithHumanTranslation(...args: Parameters<typeof resolveReportWithHumanTranslationImplementation>): Promise<Awaited<ReturnType<typeof resolveReportWithHumanTranslationImplementation>>> {
  return withMarkdownScope("write", args[1], async () => {
    try { return await resolveReportWithHumanTranslationImplementation(...args); }
    catch (error) { if (error instanceof MarkdownBudgetError) return { ok: false, error: "body_too_complex" }; throw error; }
  });
}
