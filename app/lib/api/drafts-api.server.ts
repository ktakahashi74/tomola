import { and, eq } from "drizzle-orm";
import { BEARER_PATTERN, bearerChallenge, errorResponse, guarded, memberResponse } from "~/lib/api/http.server";
import type { Db } from "~/lib/db/client.server";
import { getDb } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { countApiDrafts, createDraft } from "~/lib/drafts.server";
import { messageOf, type DraftApiError } from "~/lib/draft-errors.server";
import { resolvePostLanguage } from "~/lib/lang-detect";
import { checkDraftIssues } from "~/lib/draft-issues.server";
import { withMarkdownScope } from "~/lib/markdown-budget.server";
import { checkEntryInput } from "~/lib/entries.server";
import { extractFrontmatter, interpretFrontmatter, type Declared } from "~/lib/entry-frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import { getWriter } from "~/lib/members.server";
import { defaultPostLang } from "~/lib/profiles.server";
import { DRAFT_RATE_LIMIT, hitIpLimit, hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { authenticateToken } from "~/lib/tokens.server";
import { normalizeNewlines } from "~/lib/text";
import { villagesEnabled } from "~/lib/villages-enabled.server";

// POST /api/drafts: an AI tool submits Markdown, optionally with initial frontmatter, to create a draft. It cannot publish
// (the member must open /drafts/:id in the browser and approve publication).
//
// - Authenticate only with Authorization: Bearer tml_draft_... . Ignore cookies and ?k=; even with a cookie, a missing header produces 401.
//   Read tokens receive 403 (wrong_token_kind). No Origin check is needed because cookies are rejected. Set no CORS headers.
// - Rate limit draft creation to 30/hour per token (429 with Retry-After), counted after authentication and before reading the body.
// - Require Content-Type text/markdown or text/plain, with only charset=utf-8; otherwise 415. Limit the body to 256 KiB; reject larger bodies with 413.
// - Validate like browser posts: title, body, language, AI disclosure and renderability. Replies also require a readable target.
// - Questions accept frontmatter asks_stance: true (topics only), alt_of: p-<id> (alternative framing; questions only), and stance_tag (replies to questions only). Invalid values receive HTTP 400 invalid_asks_stance,
//   invalid_alt_of or invalid_stance_tag. The API cannot write a stance itself: ignore keys such as stance in frontmatter; stance submission belongs exclusively to the browser panel.
// - Success returns 201 { id, approve_url, lang, language, issues, issues_truncated, issues_notice?, issues_unavailable? }. Preserve via="api", token_id and received frontmatter (raw_frontmatter) in the draft.
// - Errors are JSON { error, message }.

export const MAX_DRAFT_BYTES = 256 * 1024;
// Per-member limit on API-created drafts awaiting approval. A member can own 20 tokens, so a per-token rate limit alone could allow unbounded accumulation.
// Once exceeded, no new drafts can be created until existing ones are published or deleted (429 too_many_pending_drafts).
export const MAX_PENDING_API_DRAFTS = 100;

// JSON error ({ error, message }) with the same headers as member responses, including Cache-Control: private, no-store.
const fail = (request: Request, status: number, error: string, message: string, headers: Record<string, string> = {}): Response =>
  errorResponse(request, "json", status, error, message, headers);

// Maximum oversized-body length to drain and discard. Failing to drain the remaining body before replying may terminate the connection
// before the client reads the 413 (ECONNRESET). Stop reading and abort larger bodies; losing that connection is acceptable.
const DRAIN_LIMIT = 2 * 1024 * 1024;

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, alreadyRead: number): Promise<void> {
  let size = alreadyRead;
  try {
    while (size <= DRAIN_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
    }
    await reader.cancel();
  } catch {
    // Return 413 even if draining fails.
  }
}

// Read the body with a size limit, stopping when bytes read exceed it even without Content-Length. Return null on overflow.
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await drain(reader, 0);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await drain(reader, size);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Resolve a reply target to its topic (threadId) and parent reply (parentId, null for a direct topic reply). Deleted topics and hidden topics/replies cannot be targets
// (hide their existence by returning reply_to_not_found).
async function resolveReplyTarget(db: Db, target: { kind: "topic" | "reply"; id: number }): Promise<{ threadId: number; parentId: number | null } | "reply_to_not_found" | "thread_deleted"> {
  const [row] = await db
    .select({ kind: entries.kind, threadId: entries.threadId, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(eq(entries.id, target.id));
  if (!row || row.kind !== (target.kind === "topic" ? "topic" : "reply")) return "reply_to_not_found";
  if (row.hiddenAt) return "reply_to_not_found";
  if (target.kind === "topic") return row.deletedAt ? "thread_deleted" : { threadId: target.id, parentId: null };
  const threadId = row.threadId as number;
  const [topic] = await db.select({ deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt }).from(entries).where(and(eq(entries.id, threadId), eq(entries.kind, "topic")));
  if (!topic || topic.deletedAt) return "thread_deleted";
  if (topic.hiddenAt) return "reply_to_not_found";
  // Deleted replies cannot receive replies; they are absent from the interface too.
  return row.deletedAt ? "reply_to_not_found" : { threadId, parentId: target.id };
}

const tooManyPending = (request: Request): Response =>
  fail(request, 429, "too_many_pending_drafts", `You already have ${MAX_PENDING_API_DRAFTS} drafts from the API waiting for you. Publish or delete some in the browser first.`);

export async function handleDraftCreate(request: Request, opts: { db?: Db; now?: Date } = {}): Promise<Response> {
  if (request.method !== "POST") return fail(request, 405, "method_not_allowed", "Use POST.", { Allow: "POST" });
  // Convert unexpected exceptions to JSON HTTP 500 ({ error: "internal" }) instead of an HTML error page, while still logging them.
  return guarded(request, "json", "drafts-api", () => createDraftResponse(request, opts));
}

async function createDraftResponse(request: Request, opts: { db?: Db; now?: Date }): Promise<Response> {
  const db = opts.db ?? (await getDb());

  // Authenticate with draft-only Bearer tokens. Limit unauthenticated or invalid requests to 120/hour per IP; beyond that return 429 instead of 401.
  const denied = async (status: number, code: string, message: string, headers: Record<string, string>): Promise<Response> => {
    const ipRate = await hitIpLimit(db, request, "anon", opts.now);
    if (ipRate && !ipRate.allowed) return fail(request, 429, "rate_limited", `Too many requests without valid credentials. Try again in ${ipRate.retryAfterSeconds} seconds.`, rateLimitHeaders(ipRate));
    return fail(request, status, code, message, headers);
  };
  const authorization = request.headers.get("authorization");
  if (authorization === null) return denied(401, "unauthorized", "Send a draft token: Authorization: Bearer tml_draft_… (cookies and ?k= are not accepted here).", bearerChallenge());
  const presented = BEARER_PATTERN.exec(authorization)?.[1];
  if (!presented) return denied(401, "invalid_token", "The Authorization header must be: Bearer <draft token>.", bearerChallenge("invalid_token"));
  const auth = await authenticateToken(db, presented, { now: opts.now });
  if (!auth.ok) return denied(401, "invalid_token", "The token is not valid, or it was revoked.", bearerChallenge("invalid_token"));
  if (auth.token.kind !== "draft") return fail(request, 403, "wrong_token_kind", "This is a read token. Creating drafts needs a draft token (tml_draft_…).");
  // Writing gate: the same decision as requireWriter (app/lib/members.server.ts).
  const writer = await getWriter(db, auth.token.userId);
  if (!writer.ok) {
    switch (writer.reason) {
      case "not_a_member":
        return fail(request, 403, "not_a_member", "This account has not finished signing up.");
      case "trial_consent_required":
      case "trial_restricted":
        return fail(request, 403, writer.reason, "Review your participation in the browser. Reading remains available.");
      case "suspended":
        return fail(request, 403, "suspended", `This account is suspended until ${writer.until.toISOString()}, so it cannot write. Reading is still possible.`);
    }
  }
  const profile = writer.profile;

  // Rate limit, counted before reading the body.
  const rate = await hitRateLimit(db, { key: `draft:member:${auth.token.userId}`, ...DRAFT_RATE_LIMIT, now: opts.now });
  if (!rate.allowed) return fail(request, 429, "rate_limited", `Too many drafts. Try again in ${rate.retryAfterSeconds} seconds.`, rateLimitHeaders(rate));

  if ((await countApiDrafts(db, auth.token.userId)) >= MAX_PENDING_API_DRAFTS) return tooManyPending(request);

  // Content type and size.
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(request.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
  if ((type !== "text/markdown" && type !== "text/plain") || (charset !== undefined && charset !== "utf-8" && charset !== "utf8")) {
    return fail(request, 415, "unsupported_media_type", "Content-Type must be text/markdown or text/plain (UTF-8).");
  }
  const bytes = await readLimited(request, MAX_DRAFT_BYTES);
  if (bytes === null) return fail(request, 413, "payload_too_large", `The body is larger than ${MAX_DRAFT_BYTES / 1024} KiB.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(request, 400, "invalid_encoding", messageOf("invalid_encoding"));
  }

  const bad = (error: DraftApiError) => fail(request, 400, error, messageOf(error));
  // PostgreSQL text cannot store NUL (U+0000); attempting to save it throws.
  if (text.includes("\u0000")) return bad("invalid_encoding");

  // Optional frontmatter.
  const extracted = await extractFrontmatter(text, { strict: true });
  if (!extracted.ok) return bad(extracted.error);
  let declared: Declared = { kind: "topic" };
  if (extracted.found) {
    const interpreted = interpretFrontmatter(extracted.data);
    if (!interpreted.ok) return bad(interpreted.error);
    declared = interpreted.declared;
  }
  const body = normalizeNewlines(extracted.body);
  const { lang, langCode, language } = await withMarkdownScope("write", auth.token.userId, () => resolvePostLanguage(body, declared.lang, defaultPostLang(profile)));
  // Not stated in the frontmatter: nothing is recorded (null), not "none".
  const aiAssistance = declared.aiAssistance ?? null;

  // Validate like browser posts; also validate the target for replies.
  let target: { threadId: number; parentId: number | null } | null = null;
  if (declared.kind === "reply") {
    const resolved = await resolveReplyTarget(db, declared.replyTo!);
    if (typeof resolved === "string") return bad(resolved);
    target = resolved;
  }
  // The title is optional: without a title (or with a blank one) the draft is a topic without a title, a short remark.
  const title = declared.title === undefined || declared.title.trim() === "" ? undefined : normalizeNewlines(declared.title);
  const problem =
    declared.kind === "topic"
      ? (await checkEntryInput("topic", { title, body, lang, aiAssistance, asksStance: declared.asksStance ?? false, altOf: declared.altOf }, auth.token.userId))
      : (await checkEntryInput("reply", { body, lang, aiAssistance, stanceTag: declared.stanceTag }, auth.token.userId));
  if (problem) return bad(problem === "thread_not_found" || problem === "parent_not_in_thread" ? "reply_to_not_found" : problem);

  const created = await createDraft(
    db,
    auth.token.userId,
    declared.kind === "topic"
      ? { kind: "topic", title, body, lang, aiAssistance, asksStance: declared.asksStance ?? false, altOf: declared.altOf, ...(villagesEnabled() ? { village: declared.village } : {}) }
      : { kind: "reply", threadId: target!.threadId, parentId: target!.parentId, body, lang, aiAssistance, stanceTag: declared.stanceTag, ...(villagesEnabled() ? { village: declared.village } : {}) },
    { via: "api", tokenId: auth.token.id, client: { key: `token:${auth.token.id}`, id: `token:${auth.token.id}`, name: auth.token.name, uri: null }, rawFrontmatter: extracted.found ? extracted.raw : null, now: opts.now, maxPendingApiDrafts: MAX_PENDING_API_DRAFTS },
  );
  if (!created.ok) {
    // The 100-draft limit is decided here by counting under the member-row lock. The earlier check is only an early rejection before reading the body.
    if (created.error === "too_many_pending_drafts") return tooManyPending(request);
    if (created.error === "village_required") return bad("village_required");
    // The reply target disappeared after validation because of a concurrent deletion.
    if (created.error === "thread_not_found" || created.error === "parent_not_in_thread") return bad("reply_to_not_found");
    // Invalid combinations of question attributes (an unreadable original question, a tag on a reply to a non-question topic, etc.) are input errors.
    if (created.error === "invalid_asks_stance" || created.error === "invalid_alt_of" || created.error === "invalid_stance_tag") return bad(created.error);
    // A rejected save after all validation has passed is our error; do not report it as an input error.
    console.error(`[drafts-api] createDraft refused an input that passed validation: ${created.error}`);
    return fail(request, 500, "internal", "Internal error. Try again later.");
  }
  const issues = await checkDraftIssues(db, { kind: declared.kind, lang, title, body, authorId: auth.token.userId });
  return memberResponse(request, JSON.stringify({ id: created.id, lang, lang_code: langCode, language, issues: issues.issues, issues_truncated: issues.issuesTruncated,
    ...(issues.issuesNotice ? { issues_notice: issues.issuesNotice } : {}), ...(issues.issuesUnavailable ? { issues_unavailable: true } : {}),
    approve_url: siteUrl(`/drafts/${created.id}`), ...(villagesEnabled() && declared.kind === "topic" ? { village: created.village ?? null } : {}) }), { format: "json", status: 201, rate });
}
