import type { Route } from "./+types/ai-draft";
import { requireWriter } from "~/lib/auth/session.server";
import { createDraft, getDraft, updateDraft } from "~/lib/drafts.server";
import { applyPastedFrontmatter, formString, readEntryForm, readReplyParent } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { parseIdOrNull } from "~/lib/params.server";
import { defaultPostLang } from "~/lib/profiles.server";
import { DRAFT_RATE_LIMIT, hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { signingViewToken } from "~/lib/signing.server";
import { titleOrNull } from "~/lib/text";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import { responseIdFromForm } from "~/lib/response-post.server";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
}

export function loader() { return json({ error: "method_not_allowed" }, 405, { Allow: "POST" }); }

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  let member;
  try { member = await requireWriter(request); }
  catch (error) {
    if (error instanceof Response && error.status === 302) {
      return json({ error: error.headers.get("location") === "/login" ? "login_required" : "write_unavailable" }, error.headers.get("location") === "/login" ? 401 : 403);
    }
    throw error;
  }
  try { return await saveAiDraft(request, member); }
  catch (error) {
    if (error instanceof MarkdownBusyError) return json({ error: "rate_limited" }, 503, { "Retry-After": "1", "Cache-Control": "no-store" });
    throw error;
  }
}

async function saveAiDraft(request: Request, member: Awaited<ReturnType<typeof requireWriter>>) {
  const { user, db, profile } = member;
  const form = await request.formData();
  // A session renewed in another account cannot claim the text captured by this editor.
  if (formString(form, "ownerId") !== user.id) return json({ error: "account_changed" }, 409);
  if (formString(form, "intro") === "1") return json({ error: "invalid_intro" }, 400);
  const raw = readEntryForm(form);
  const kindValue = formString(form, "kind");
  if (kindValue && kindValue !== "topic" && kindValue !== "reply") return json({ error: "invalid_draft" }, 400);
  const kind = kindValue === "reply" ? "reply" : "topic";
  const threadId = kind === "reply" ? parseIdOrNull(formString(form, "threadId")) : null;
  if (kind === "reply" && threadId === null) return json({ error: "not_found" }, 404);
  const parentId = kind === "reply" ? readReplyParent(form) : undefined;
  if (parentId !== undefined && parentId !== null && (!Number.isSafeInteger(parentId) || parentId < 1)) return json({ error: "parent_not_in_thread" }, 400);
  const idValue = formString(form, "draftId");
  let id: number;
  let version: number;
  let savedInput: { title: string; body: string; lang: string; asksStance: boolean };
  if (idValue) {
    const parsedId = parseIdOrNull(idValue);
    if (parsedId === null) return json({ error: "not_found" }, 404);
    id = parsedId;
    const existing = await getDraft(db, user.id, id);
    if (!existing || existing.kind !== kind || existing.via !== "web" || existing.clientId || kind === "reply" && existing.threadId !== threadId) return json({ error: "not_found" }, 404);
    if (kind === "reply" && parentId !== undefined && parentId !== existing.parentId) return json({ error: "draft_conflict" }, 409);
    const expectedVersion = Number(formString(form, "version"));
    const bodyError = await checkBodyBudget(raw.body, user.id);
    if (bodyError) return json({ error: bodyError }, 400);
    const saved = await updateDraft(db, user.id, id, { title: raw.title, body: raw.body, lang: raw.lang, asksStance: raw.asksStance, ...(form.has("stanceTag") ? { stanceTag: raw.stanceTag } : {}), ...(villagesEnabled() ? { village: raw.village } : {}) }, { expectedVersion });
    if (!saved.ok) return json({ error: saved.error }, saved.error === "draft_conflict" ? 409 : saved.error === "not_found" ? 404 : 400);
    version = saved.version!;
    savedInput = raw;
  } else {
    const rate = await hitRateLimit(db, { key: `draft:member:${user.id}`, ...DRAFT_RATE_LIMIT });
    if (!rate.allowed) return json({ error: "rate_limited" }, 429, rateLimitHeaders(rate));
    const pasted = (await applyPastedFrontmatter(raw, kind, { defaultLang: defaultPostLang(profile), ...(kind === "reply" ? { threadId: threadId!, parentId } : {}) }));
    if (!pasted.ok) return json({ error: pasted.error }, 400);
    const bodyError = await checkBodyBudget(pasted.input.body, user.id);
    if (bodyError) return json({ error: bodyError }, 400);
    const created = await createDraft(db, user.id, { kind, ...(kind === "reply" ? { threadId: threadId!, parentId: pasted.parentId } : {}), ...pasted.input }, { responseTo: responseIdFromForm(form) });
    if (!created.ok) return json({ error: created.error }, 400);
    id = created.id;
    version = 1;
    savedInput = pasted.input;
  }
  return json({ id, version, title: titleOrNull(savedInput.title), asksStance: savedInput.asksStance, lang: savedInput.lang, body: savedInput.body, signingView: signingViewToken({ userId: user.id, kind: "draft", id, version: String(version), title: titleOrNull(savedInput.title), body: savedInput.body, lang: savedInput.lang }) });
}
