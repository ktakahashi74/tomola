import { data, redirect } from "react-router";
import type { requireWriter } from "~/lib/auth/session.server";
import { defaultPostLang } from "~/lib/profiles.server";
import { applyPastedFrontmatter, formString, readEntryForm, readReplyParent } from "~/lib/entry-form.server";
import { createReply, deleteOwnEntry, isEntryInThread, replyLocation } from "~/lib/entries.server";
import { createDraft, deleteLinkedDraft, linkedDraftOf, updateDraft } from "~/lib/drafts.server";
import { createReport } from "~/lib/moderation.server";
import { createTranslationReport, updateTranslationReportDetails } from "~/lib/translation-reports.server";
import { setIntroduction, unsetIntroduction } from "~/lib/member-pages.server";
import { DRAFT_RATE_LIMIT, hitRateLimit, hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { langCarry } from "~/lib/display-lang.server";
import { failure, parseIdOrNull } from "~/lib/params.server";
import { withSignedWrite } from "~/lib/signing.server";
import { postedLocation } from "~/lib/posted-ui";

type TopicAction = Awaited<ReturnType<typeof requireWriter>> & { request: Request; form: FormData; threadId: number; intent: string };

async function introductionResult(result: Awaited<ReturnType<typeof setIntroduction>>, threadId: number) {
  if (!result.ok) {
    if (result.error === "not_found" || result.error === "forbidden") failure(result.error);
    return data({ intent: "intro" as const, error: result.error, reported: false }, { status: 400 });
  }
  throw redirect(`/t/${threadId}`);
}
export async function setTopicIntroduction({ db, user, threadId }: TopicAction) {
  return introductionResult(await setIntroduction(db, user.id, threadId), threadId);
}
export async function unsetTopicIntroduction({ db, user, threadId }: TopicAction) {
  return introductionResult(await unsetIntroduction(db, user.id, threadId), threadId);
}

export async function deleteTopicEntry({ db, user, threadId, form, request }: TopicAction) {
  // Delete the member's own post in this thread only, requiring confirmation. Topic deletion returns home; reply deletion returns to its retained position.
  const entryId = parseIdOrNull(formString(form, "entryId"));
  if (formString(form, "confirm") !== "1" || entryId === null) throw data("Bad request", { status: 400 });
  if (!(await isEntryInThread(db, entryId, threadId))) throw data("Not found", { status: 404 });
  const res = await deleteOwnEntry(db, user.id, entryId);
  if (!res.ok) failure(res.error);
  throw redirect(res.kind === "topic" ? "/" : await replyLocation(db, res.threadId, entryId, { lang: langCarry(request) }));
}

export async function flagTopicEntry({ db, user, threadId, form }: TopicAction) {
  // Report a post in this thread only, supplying a reason category and optional explanation. Limit to 30 per member per hour.
  const entryId = parseIdOrNull(formString(form, "entryId"));
  if (entryId === null || !(await isEntryInThread(db, entryId, threadId))) {
    return data({ intent: "flag" as const, entryId, error: "not_found", reported: false }, { status: 404 });
  }
  const rate = await hitMemberLimit(db, "report", user.id);
  if (!rate.allowed) return data({ intent: "flag" as const, entryId, error: "rate_limited", reported: false }, { status: 429, headers: rateLimitHeaders(rate) });
  const res = await createReport(db, user.id, { entryId, reason: formString(form, "reason"), note: formString(form, "note") });
  if (res.ok) return data({ intent: "flag" as const, entryId, error: null, reported: true });
  return data({ intent: "flag" as const, entryId, error: res.error, reported: false }, { status: res.error === "duplicate" ? 409 : 400 });
}

export async function reportTopicTranslation({ db, user, threadId, form, intent }: TopicAction) {
  // Report a mistranslation from an entry displaying a translation, limited to posts in this thread.
  const entryId = parseIdOrNull(formString(form, "entryId"));
  const reportTarget = { lang: formString(form, "lang"), field: formString(form, "field") };
  if (entryId === null || !(await isEntryInThread(db, entryId, threadId))) {
    return data({ intent: "report" as const, entryId, ...reportTarget, error: "not_found", reported: false }, { status: 404 });
  }
  // Mistranslation reports: 30 per member per hour; excess returns 429 and a UI message.
  const rate = await hitMemberLimit(db, "translation-report", user.id);
  if (!rate.allowed) return data({ intent: "report" as const, entryId, ...reportTarget, error: "rate_limited", reported: false }, { status: 429, headers: rateLimitHeaders(rate) });
  const input = {
    entryId,
    lang: formString(form, "lang"),
    field: formString(form, "field"),
    excerpt: formString(form, "excerpt"),
    note: formString(form, "note"),
  };
  const reportId = parseIdOrNull(formString(form, "reportId"));
  if (intent === "report-details" && reportId === null) return data({ intent: "report" as const, entryId, ...reportTarget, error: "not_found", reported: false }, { status: 400 });
  const res = intent === "report-details"
    ? await updateTranslationReportDetails(db, user.id, reportId!, input)
    : await createTranslationReport(db, user.id, input);
  if (res.ok) return data({ intent: "report" as const, entryId, ...reportTarget, error: null, reported: true, reportId: res.id });
  return data({ intent: "report" as const, entryId, ...reportTarget, error: res.error, reported: false }, { status: 400 });
}

function replyError(form: FormData, error: string, status = 400, headers?: HeadersInit) {
  return data({ intent: "reply" as const, error, reported: false, input: readEntryForm(form) }, { status, headers });
}
async function replyInput({ form, profile, threadId, intent }: TopicAction) {
  const selectedParent = readReplyParent(form);
  if (selectedParent !== undefined && selectedParent !== null && (!Number.isSafeInteger(selectedParent) || selectedParent < 1)) {
    return { ok: false as const, response: replyError(form, "parent_not_in_thread") };
  }
  const pasted = await applyPastedFrontmatter(readEntryForm(form), "reply", { defaultLang: defaultPostLang(profile), allowComplex: intent === "draft", threadId, parentId: selectedParent });
  if (!pasted.ok) return { ok: false as const, response: replyError(form, pasted.error) };
  return { ok: true as const, input: pasted.input, parentId: pasted.parentId };
}
export async function saveReplyDraft(context: TopicAction) {
  const { db, user, form, threadId } = context;
  const pasted = await replyInput(context);
  if (!pasted.ok) return pasted.response;
  const rate = await hitRateLimit(db, { key: `draft:member:${user.id}`, ...DRAFT_RATE_LIMIT });
  if (!rate.allowed) return replyError(form, "rate_limited", 429, rateLimitHeaders(rate));
  const { body, lang, aiAssistance, stanceTag } = pasted.input;
  // A draft that "Write with AI" made from this screen is updated in place (at the version this screen saw), not copied: an AI may have changed it since.
  const linked = linkedDraftOf(form);
  if (linked) {
    const updated = await updateDraft(db, user.id, linked.id, { body, lang, aiAssistance, stanceTag }, { expectedVersion: linked.version });
    if (updated.ok) throw redirect(`/drafts/${linked.id}`);
    if (updated.error === "draft_conflict") return replyError(form, "draft_conflict", 409);
    if (updated.error !== "not_found") return replyError(form, updated.error);
  }
  const draft = await createDraft(db, user.id, { kind: "reply", threadId, parentId: pasted.parentId, body, lang, aiAssistance, stanceTag });
  if (draft.ok) throw redirect(`/drafts/${draft.id}`);
  return replyError(form, draft.error);
}
export async function postTopicReply(context: TopicAction) {
  const { db, user, request, form, threadId } = context;
  const pasted = await replyInput(context);
  if (!pasted.ok) return pasted.response;
  const rate = await hitMemberLimit(db, "reply", user.id);
  if (!rate.allowed) return replyError(form, "rate_limited", 429, rateLimitHeaders(rate));
  const { body, lang, langCode, langSource, aiAssistance, stanceTag } = pasted.input;
  // The draft that "Write with AI" made is removed in the same transaction, so that a failure here cannot leave a reply made and the form still sendable.
  const res = await withSignedWrite(db, user.id, request, form, async tx => {
    const created = await createReply(tx, user.id, threadId, { body, lang, langCode, langSource, aiAssistance, parentId: pasted.parentId, stanceTag, suppressNushi: pasted.input.suppressNushi, ...(form.has("nushiParentId") ? { nushiParentId: Number(form.get("nushiParentId")) } : {}) });
    if (created.ok) await deleteLinkedDraft(tx, user.id, form, { questionReplyPublished: true });
    return created;
  });
  if (res.ok) {
    throw redirect(postedLocation(await replyLocation(db, threadId, res.id, { lang: langCarry(request) }), res.id, res.followed));
  }
  return replyError(form, res.error);
}
