import { MarkdownBudgetError, MarkdownBusyError } from "~/lib/markdown-budget.server";
import type { Route } from "./+types/preview";
import { requireMember } from "~/lib/auth/session.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { MAX_BODY_LENGTH } from "~/lib/entries.server";
import { extractPasted, interpretFrontmatter } from "~/lib/entry-frontmatter.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { formString, isKindMismatch } from "~/lib/entry-form.server";
import { checkBodyBudget, tryRenderMarkdown } from "~/lib/markdown.server";
import { resolveMentionTargets } from "~/lib/mentions.server";
import { isLang } from "~/lib/languages";
import { defaultPostLang } from "~/lib/profiles.server";
import { resolvePostLanguage } from "~/lib/lang-detect";
import { normalizeNewlines } from "~/lib/text";

// Preview resource route for members only. No loader, so GET is unsupported.
// Return an HTML fragment rendered from form body with the same renderMarkdown used for posts.
// Footnote IDs use a prefix distinct from actual posts (p-<id>- / c-<id>-).
export async function action({ request }: Route.ActionArgs) {
  try { return await preview(request); }
  catch (error) {
    if (error instanceof MarkdownBusyError) return Response.json({ error: "rate_limited" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    throw error;
  }
}

async function preview(request: Request) {
  // Reject rendering from cross-site POSTs (CSRF); rendering consumes server resources.
  assertSameOrigin(request);
  const { user, db, profile } = await requireMember(request);
  // Limit resource-consuming preview rendering to 300 per member per hour. Excess returns 429; the UI asks the member to wait.
  const rate = await hitMemberLimit(db, "preview", user.id);
  if (!rate.allowed) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "no-store" } });
  }
  const form = await request.formData();
  const text = normalizeNewlines(formString(form, "body"));
  // For forms that parse and strip pasted frontmatter (frontmatter=topic or reply for new topics and replies), omit it from preview too. Use the same rule as submission:
  // YAML maps containing post keys (extractPasted). If parsing succeeds but values are invalid, such as lang or reply_to, submission rejects them,
  // so preview also returns frontmatter_invalid. Other forms (editing and drafts) save the body verbatim and render it verbatim.
  let body = text;
  let lang = formString(form, "lang");
  const kind = formString(form, "frontmatter");
  if (kind === "topic" || kind === "reply") {
    let pasted;
    try { pasted = await extractPasted(text); }
    catch (error) { if (error instanceof MarkdownBudgetError) return Response.json({ error: "body_too_complex" }, { status: 400 }); throw error; }
    if (pasted.pasted) {
      const interpreted = interpretFrontmatter(pasted.data, { requireReplyTo: false });
      if (!interpreted.ok) return Response.json({ error: "frontmatter_invalid" }, { status: 400 });
      if (isKindMismatch(interpreted.declared, kind)) return Response.json({ error: "frontmatter_type_mismatch" }, { status: 400 });
      body = pasted.body;
      lang ||= interpreted.declared.lang ?? "";
    }
  }
  if (body.length > MAX_BODY_LENGTH) return Response.json({ error: "body_too_long" }, { status: 400 });
  const bodyError = await checkBodyBudget(body, user.id);
  if (bodyError) return Response.json({ error: bodyError }, { status: 400 });
  // Match publication's language for typesetting and fixed footnote text, including automatic selection.
  let html;
  try {
    if (!isLang(lang)) lang = (await resolvePostLanguage(body, undefined, defaultPostLang(profile))).lang;
    html = await tryRenderMarkdown(body, { idPrefix: "preview-", lang, mentions: await resolveMentionTargets(db, body) });
  }
  catch (error) { if (error instanceof MarkdownBudgetError) return Response.json({ error: "body_too_complex" }, { status: 400 }); throw error; }
  if (html === null) return Response.json({ error: "body_unrenderable" }, { status: 400 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Language": lang,
      // As a fragment, allow no execution even if opened directly; the rendered result is already sanitized, but guard defensively.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
