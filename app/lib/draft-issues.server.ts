import { isEnabledLang } from "./enabled-langs.server";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { media } from "./db/schema";
import { DRAFT_ISSUES_NOTICE, draftExcerpt, MAX_DRAFT_ISSUES, type DraftIssue } from "./draft-issues";
import type { inspectDraftMarkdown } from "./draft-issues.core.server";
import { detectSourceLanguage } from "./lang-detect";
import { MarkdownBudgetError, MarkdownBusyError, markdownTask, withMarkdownScope } from "./markdown-budget.server";
import { mediaImage } from "./markdown.server";
import { canReadMedia } from "./media-references.server";
import { resolveMentionTargets } from "./mentions.server";
import { unicodeReviewCounts, unicodeReviewReasons } from "./unicode-review";

type DraftIssuesInput = { kind: string; lang: string; title?: string | null; body: string; authorId: string };
type DraftIssuesResult = { issues: DraftIssue[]; issuesTruncated: boolean; issuesNotice?: string; issuesUnavailable?: true };

// Diagnostics are advisory, so their failure must never reject a draft read or save.
export async function checkDraftIssues(db: Db, draft: DraftIssuesInput, onBusy?: () => void): Promise<DraftIssuesResult> {
  try { return await collectDraftIssues(db, draft); }
  catch (error) {
    if (error instanceof MarkdownBusyError) onBusy?.();
    else if (!(error instanceof MarkdownBudgetError)) console.error("[draft-issues] Diagnostics unavailable", error);
    return { issues: [], issuesTruncated: false, issuesUnavailable: true };
  }
}

function collectDraftIssues(db: Db, draft: DraftIssuesInput) {
  return withMarkdownScope("write", draft.authorId, async () => {
    const targets = await resolveMentionTargets(db, draft.body);
    const inspected = await markdownTask<ReturnType<typeof inspectDraftMarkdown>>("inspectDraftMarkdown", [draft.body, draft.lang, targets, draft.authorId]);
    // Worker results may be cached. Never append request-specific diagnostics to that cache.
    const issues: DraftIssue[] = [...inspected.issues];
    const add = (issue: DraftIssue) => { if (issues.length <= MAX_DRAFT_ISSUES) issues.push(issue); };
    // A fresh upload by this author becomes readable through the new post. Other uploads
    // must already have a publicly readable reference, using the media route's own policy.
    const available = new Map<string, boolean>();
    for (const image of inspected.images) {
      if (issues.length > MAX_DRAFT_ISSUES) break;
      const parsed = mediaImage(image.src)!;
      if (!available.has(image.src)) {
        const [stored] = await db.select({ uploadedBy: media.uploadedBy, avatar: media.avatar, width: media.width, height: media.height, deletedAt: media.deletedAt }).from(media).where(eq(media.id, parsed.id));
        available.set(image.src, !!stored && !stored.deletedAt && stored.width === parsed.width && stored.height === parsed.height
          && ((!stored.avatar && stored.uploadedBy === draft.authorId) || await canReadMedia(db, parsed.id, null)));
      }
      if (!available.get(image.src)) add({ kind: "image_not_rendered", location: { field: "body", line: image.line }, excerpt: image.excerpt,
        message: "This managed image is unavailable to readers. Upload an image you can publish if an image is intended." });
    }
    const review = (text: string, location: DraftIssue["location"]) => {
      for (const reason of unicodeReviewReasons(unicodeReviewCounts(text))) add({ kind: "unicode_review", location, excerpt: draftExcerpt(text), message: `Review the ${reason} format characters with your member; they can be intentional.` });
    };
    if (draft.kind === "topic" && draft.title) review(draft.title, { field: "title" });
    const lines = draft.body.split(/\r?\n/);
    for (let i = 0; i < lines.length && issues.length <= MAX_DRAFT_ISSUES; i++) review(lines[i], { field: "body", line: i + 1 });
    const detected = await detectSourceLanguage(draft.body, draft.lang);
    if (detected && detected.lang !== draft.lang && !(draft.lang === "other" && !isEnabledLang(detected.lang))) add({ kind: "lang_mismatch", location: { field: "body", line: 1 }, excerpt: draftExcerpt(draft.body),
      message: `The body appears to be ${detected.langCode ?? detected.lang}, but lang is ${draft.lang}. Check the intended language with your member.` });
    return { issues: issues.slice(0, MAX_DRAFT_ISSUES), issuesTruncated: issues.length > MAX_DRAFT_ISSUES, ...(issues.length ? { issuesNotice: DRAFT_ISSUES_NOTICE } : {}) };
  });
}
