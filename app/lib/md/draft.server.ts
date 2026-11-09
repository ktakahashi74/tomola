import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { getActiveMember } from "~/lib/members.server";
import { ensureOperatorRow } from "~/lib/roles.server";
import { hitBrowserReadLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { errorResponse, guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { getDraft, type Draft } from "~/lib/drafts.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { twinPreamble } from "~/lib/md/urls.server";
import { parseIdOrNull } from "~/lib/params.server";

export function buildDraftMarkdown(draft: Draft): string {
  return mdBlock({
    type: draft.kind === "topic" ? "post" : "comment", draft: true, draft_id: draft.id, version: draft.version,
    lang: draft.lang, title: draft.title ?? undefined,
    ...(villagesEnabled() && draft.kind === "topic" ? { village: draft.village ?? null } : {}),
    reply_to: draft.kind === "reply" ? `${draft.parentId === null ? "p" : "c"}-${draft.parentId ?? draft.threadId}` : undefined,
    asks_stance: draft.asksStance || undefined, alt_of: draft.altOf === null ? undefined : `p-${draft.altOf}`,
    stance_tag: draft.stanceTag ?? undefined, ai_assistance: draft.aiAssistance ?? undefined,
    content_trust: "untrusted_user_content",
  }, draft.body, { preamble: twinPreamble() });
}

// Drafts retain the browser screen's ownership boundary. Read tokens do not gain access.
export async function draftMdMiddleware({ request, params }: { request: Request; params: Record<string, string | undefined> }, next: () => Promise<Response>): Promise<Response> {
  const stem = params.id && /^(.+)\.(?:md|txt)$/.exec(params.id)?.[1];
  if (!villagesEnabled() || !stem) return next();
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "md-draft", async () => {
    const user = await getSessionUser(request);
    if (!user) return errorResponse(request, "text", 401, "unauthorized", "Log in as the draft's author to read this draft.");
    const db = await getDb();
    if (!await getActiveMember(db, user.id)) return errorResponse(request, "text", 403, "not_a_member", "Finish signing up before reading drafts.");
    const rate = await hitBrowserReadLimit(db, request, user.id);
    if (!rate.allowed) return errorResponse(request, "text", 429, "rate_limited", "Too many reads. Try again later.", rateLimitHeaders(rate));
    await ensureOperatorRow(db, user);
    const id = parseIdOrNull(stem);
    const draft = id === null ? null : await getDraft(db, user.id, id);
    return draft ? memberResponse(request, buildDraftMarkdown(draft), { rate }) : notFound(request, "text");
  });
}
