import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as markdown from "~/lib/markdown.server";
import * as markdownBudget from "~/lib/markdown-budget.server";
import { MarkdownBudgetError, MarkdownBusyError } from "~/lib/markdown-budget.server";
import { drafts, entries, profiles, rateLimits } from "~/lib/db/schema";
import { messageOf } from "~/lib/draft-errors.server";
import { DRAFT_ISSUES_NOTICE } from "~/lib/draft-issues";
import { MAX_DRAFT_BYTES, MAX_PENDING_API_DRAFTS } from "~/lib/api/drafts-api.server";
import { countApiDrafts, getDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { createApiToken, revokeApiToken } from "~/lib/tokens.server";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let draftToken: string;
let draftTokenId: number;
let readToken: string;
let topicId: number;
let replyId: number;

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("somchai", { homeArea: "th", readLangs: ["th"] });
  const d = await createApiToken(h.db, h.ids.hana, { name: "claude code", kind: "draft" });
  const r = await createApiToken(h.db, h.ids.hana, { name: "reader", kind: "read" });
  if (!d.ok || !r.ok) throw new Error("token failed");
  draftToken = d.token;
  draftTokenId = d.summary.id;
  readToken = r.token;
  const topic = await createTopic(h.db, h.ids.somchai, { lang: "th", title: "หัวข้อ", body: "เนื้อหา" });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;
  const reply = await createReply(h.db, h.ids.somchai, topicId, { lang: "th", body: "ตอบ" });
  if (!reply.ok) throw new Error("reply failed");
  replyId = reply.id;
});
afterAll(() => h.restore());

type Sent = { status: number; headers: Headers; json: Record<string, unknown> };
// Reset counters between tests except the 30-per-hour rate-limit test, so other checks do not hit the limit.
async function post(body: string | Uint8Array | null, opts: { token?: string | null; type?: string | null; headers?: Record<string, string>; url?: string; method?: string; keepLimit?: boolean } = {}): Promise<Sent> {
  if (!opts.keepLimit) await h.db.delete(rateLimits);
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token === undefined ? draftToken : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const type = opts.type === undefined ? "text/markdown" : opts.type;
  if (type) headers["content-type"] = type;
  const request = new Request(`${BASE}${opts.url ?? "/api/drafts"}`, { method: opts.method ?? "POST", headers, body: opts.method && opts.method !== "POST" ? undefined : (body as BodyInit | null) });
  const { action, loader } = await import("~/routes/api.drafts");
  const res = (opts.method && opts.method !== "POST" ? await loader({ request, params: {}, context: {} } as never) : await action({ request, params: {}, context: {} } as never)) as Response;
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
const md = (frontmatter: string, body = "Body text.") => `---\n${frontmatter}\n---\n${body}`;
const errorOf = async (body: string, opts: Parameters<typeof post>[1] = {}) => (await post(body, opts)).json.error;

describe("POST /api/drafts: authentication", () => {
  it("needs a Bearer draft token: no header, a cookie, ?k=, a malformed header and unknown or revoked tokens are 401", async () => {
    const none = await post(md("type: topic\ntitle: T"), { token: null });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer realm="tomola"');
    expect(none.json.error).toBe("unauthorized");
    // Even with a session cookie, missing authorization header yields 401.
    const cookie = await post(md("type: topic\ntitle: T"), { token: null, headers: { cookie: "better-auth.session_token=anything" } });
    expect(cookie.status).toBe(401);
    // A real signed-in session cookie still yields 401 without Bearer, although the same session can open /drafts.
    const realCookie = h.request("/", { as: "hana" }).headers.get("cookie");
    expect(realCookie).toContain("better-auth.session_token");
    const loggedIn = await post(md("type: topic\ntitle: T"), { token: null, headers: { cookie: realCookie! } });
    expect(loggedIn.status).toBe(401);
    expect(loggedIn.json.error).toBe("unauthorized");
    expect(loggedIn.headers.get("www-authenticate")).toBe('Bearer realm="tomola"');
    expect((await h.outcome(async () => (await (await import("~/routes/drafts")).loader(await h.signedArgs(h.request("/drafts", { as: "hana" })))))).status).toBe(200);
    // With a real session cookie and a read-token Bearer, Bearer takes precedence and the read token yields 403.
    const mixed = await post(md("type: topic\ntitle: T"), { token: readToken, headers: { cookie: realCookie! } });
    expect(mixed.status).toBe(403);
    // Do not accept tokens in the URL.
    const viaUrl = await post(md("type: topic\ntitle: T"), { token: null, url: `/api/drafts?k=${draftToken}` });
    expect(viaUrl.status).toBe(401);
    for (const authorization of ["Bearer", "Basic aGFuYTpwdw==", `Token ${draftToken}`, "Bearer nonsense", `Bearer tml_draft_${"a".repeat(43)}`]) {
      const res = await post(md("type: topic\ntitle: T"), { token: null, headers: { authorization } });
      expect(res.status, authorization).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    const revoked = await createApiToken(h.db, h.ids.hana, { name: "gone", kind: "draft" });
    if (!revoked.ok) throw new Error(revoked.error);
    await revokeApiToken(h.db, h.ids.hana, revoked.summary.id);
    expect((await post(md("type: topic\ntitle: T"), { token: revoked.token })).status).toBe(401);
    expect(await h.db.select().from(drafts)).toHaveLength(0);
  });

  it("refuses a read token with 403, without revealing anything and without creating a draft", async () => {
    const res = await post(md("type: topic\ntitle: T"), { token: readToken });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("wrong_token_kind");
    expect(await h.db.select().from(drafts)).toHaveLength(0);
  });

  it("answers GET, HEAD and OPTIONS with 405 and no CORS headers", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await post(null, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-")), method).toEqual([]);
    }
    const ok = await post(md("type: topic\ntitle: No CORS"));
    expect(ok.status).toBe(201);
    expect([...ok.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("POST /api/drafts: creating a draft", () => {
  it("creates a topic draft from frontmatter and returns 201 with the id and the approval URL; nothing is published", async () => {
    const before = (await h.db.select().from(entries)).length;
    const raw = "type: topic\ntitle: Can symbiosis replace control?\nlang: en\nai_assistance: draft\nsomething_else: ignored";
    const res = await post(md(raw, "First paragraph with $x^2$.\n\nSecond."));
    expect(res.status).toBe(201);
    const id = res.json.id as number;
    expect(res.json).toEqual({ id, approve_url: `${BASE}/drafts/${id}`, lang: "en", language: { source: "explicit", detected: null }, issues: [], issues_truncated: false });
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const draft = await getDraft(h.db, h.ids.hana, id);
    expect(draft).toMatchObject({ kind: "topic", title: "Can symbiosis replace control?", lang: "en", aiAssistance: "draft", via: "api", body: "First paragraph with $x^2$.\n\nSecond.", tokenName: "claude code", rawFrontmatter: raw, threadId: null });
    const [row] = await h.db.select().from(drafts).where(eq(drafts.id, id));
    expect(row.tokenId).toBe(draftTokenId);
    expect((await h.db.select().from(entries)).length).toBe(before);
    // Invisible to other members.
    expect(await getDraft(h.db, h.ids.somchai, id)).toBeNull();
  });

  it("defaults the language to the member's first writing language and states no ai_assistance (null, not none); text/plain and a UTF-8 charset work", async () => {
    const res = await post("---\ntitle: T2\n---\nBody", { type: "text/plain; charset=UTF-8" });
    expect(res.status).toBe(201);
    expect(res.json.language).toEqual({ source: "default", detected: null });
    expect(await getDraft(h.db, h.ids.hana, res.json.id as number)).toMatchObject({ lang: "ja", aiAssistance: null, kind: "topic" });
  });

  it("detects omitted languages, shares repair messages, and returns non-blocking issues", async () => {
    const prose = "This is a place for people to share their ideas and to learn from each other.";
    const detected = await post(prose);
    expect(detected.json).toMatchObject({ lang: "en", language: { source: "detected", detected: "en" }, issues: [] });
    const warned = await post(md("lang: ja", `${prose}\n\n@missing ![remote](https://example.org/p.webp)`));
    expect(warned.status).toBe(201);
    expect((warned.json.issues as Array<{ kind: string }>).map(issue => issue.kind)).toEqual(["unknown_mention", "image_not_rendered", "lang_mismatch"]);
    expect(warned.json.issues_notice).toBe(DRAFT_ISSUES_NOTICE);
    const invalid = await post(md("lang: xx"));
    expect(invalid.json.message).toBe(messageOf("invalid_lang"));
    await h.db.update(profiles).set({ homeArea: "other", readLangs: ["en", "ja"] }).where(eq(profiles.userId, h.ids.hana));
    try {
      expect((await post("OK")).json).toMatchObject({ lang: "en", language: { source: "default", detected: null } });
    } finally {
      await h.db.update(profiles).set({ homeArea: "ja", readLangs: ["ja", "en"] }).where(eq(profiles.userId, h.ids.hana));
    }
  });

  it.each([MarkdownBusyError, MarkdownBudgetError])("saves a draft when only diagnostics raise %s", async (DiagnosticError) => {
    const run = markdownBudget.markdownTask;
    const spy = vi.spyOn(markdownBudget, "markdownTask").mockImplementation(<T>(operation: string, args: unknown[]): Promise<T> =>
      operation === "inspectDraftMarkdown" ? Promise.reject(new DiagnosticError()) : run<T>(operation, args));
    try {
      const body = "Saved even when diagnostics are unavailable";
      const result = await post(md("lang: en", body));
      expect(result.status).toBe(201);
      expect(result.json).toMatchObject({ issues: [], issues_truncated: false, issues_unavailable: true });
      for (const key of ["issuesTruncated", "issuesNotice", "issuesUnavailable"]) expect(result.json).not.toHaveProperty(key);
      expect(await getDraft(h.db, h.ids.hana, result.json.id as number)).toMatchObject({ lang: "en", body, version: 1 });
    } finally { spy.mockRestore(); }
  });

  it("accepts the frontmatter of a Markdown twin as it is (post, null reply_to, extra keys) and creates a reply draft", async () => {
    const pasted = md(`type: post\nid: p-99\ntitle: Copied\nlang: en\nthread: p-99\nreply_to: null\nauthor: "@someone"\nendorsed: true\ncontent_trust: untrusted_user_content`);
    const topic = await post(pasted);
    expect(topic.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, topic.json.id as number)).toMatchObject({ kind: "topic", title: "Copied" });
    // Reply to a topic.
    const reply = await post(md("type: comment\nreply_to: p-" + topicId + "\nlang: th"));
    expect(reply.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, reply.json.id as number)).toMatchObject({ kind: "reply", threadId: topicId, parentId: null, lang: "th", title: null, via: "api" });
    // Reply to a reply: reply_to determines reply kind even without type.
    const nested = await post(md(`reply_to: c-${replyId}`));
    expect(nested.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, nested.json.id as number)).toMatchObject({ kind: "reply", threadId: topicId, parentId: replyId });
  });

  it("creates a question draft, another way of asking it, and a marked reply draft; a stance key is ignored and no stance is written", async () => {
    const q = await createTopic(h.db, h.ids.somchai, { lang: "th", title: "คำถาม", body: "x", asksStance: true });
    if (!q.ok) throw new Error("question failed");
    const question = await post(md("type: topic\ntitle: Should we pause?\nlang: en\nasks_stance: true\nstance: agree\nstance_locked_at: 2026-10-01"));
    expect(question.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, question.json.id as number)).toMatchObject({ kind: "topic", asksStance: true, altOf: null, stanceTag: null, via: "api" });
    const alt = await post(md(`title: Another way\nlang: en\nasks_stance: true\nalt_of: p-${q.id}`));
    expect(alt.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, alt.json.id as number)).toMatchObject({ kind: "topic", asksStance: true, altOf: q.id, altTitle: "คำถาม" });
    const marked = await post(md(`reply_to: p-${q.id}\nlang: en\nstance_tag: objection`));
    expect(marked.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, marked.json.id as number)).toMatchObject({ kind: "reply", threadId: q.id, stanceTag: "objection", asksStance: false, threadAsksStance: true });
    // Question drafts have the same shape as ordinary topic drafts except question attributes; preserve frontmatter unchanged.
    const [row] = await h.db.select().from(drafts).where(eq(drafts.id, question.json.id as number));
    expect(row.rawFrontmatter).toContain("asks_stance: true");
    // Publication follows browser approval and carries question attributes into the post.
    const published = await publishDraft(h.db, h.ids.hana, alt.json.id as number);
    if (!published.ok) throw new Error(`publish failed: ${published.error}`);
    expect((await h.db.select().from(entries).where(eq(entries.id, published.id)))[0]).toMatchObject({ asksStance: true, altOf: q.id, via: "api" });
  });

  it("reads CRLF input and strips leading blank lines after the frontmatter", async () => {
    const res = await post("---\r\ntitle: CRLF\r\n---\r\n\r\nline1\r\nline2\r\n");
    expect(res.status).toBe(201);
    expect(await getDraft(h.db, h.ids.hana, res.json.id as number)).toMatchObject({ title: "CRLF", body: "line1\nline2\n" });
  });

  it("publishes nothing itself: a draft becomes a post only through the draft page, and keeps via = api", async () => {
    const created = await post(md("type: topic\ntitle: To approve\nlang: en", "Approved body."));
    const id = created.json.id as number;
    const page = await import("~/routes/draft");
    const publish = (as: string | undefined, headers: Record<string, string> = {}) =>
      h.outcome(async () => page.action(await h.signedArgs(h.request(`/drafts/${id}`, { as, form: { intent: "publish", title: "To approve", body: "Approved body.", lang: "en" }, headers }), { id: String(id) })));
    // A draft Bearer token alone cannot publish without a cookie session.
    expect(await publish(undefined, { authorization: `Bearer ${draftToken}` })).toMatchObject({ status: 302, location: "/login" });
    // Reject a request that is neither a read nor same-origin.
    expect((await publish("hana", { origin: "https://evil.example" })).status).toBe(403);
    expect((await publish("hana", { origin: "" })).status).toBe(403);
    // For another member's session, indistinguishable from a nonexistent draft.
    expect((await publish("somchai")).status).toBe(404);
    expect((await h.db.select().from(entries).where(eq(entries.title, "To approve"))).length).toBe(0);
    // The owner publishes through their browser session.
    const ok = await publish("hana");
    expect(ok.status).toBe(302);
    const [published] = await h.db.select().from(entries).where(eq(entries.title, "To approve"));
    expect(ok.location).toBe(`/t/${published.id}?posted=${published.id}`);
    expect(published).toMatchObject({ via: "api", lang: "en", body: "Approved body.", authorId: h.ids.hana });
    expect(await getDraft(h.db, h.ids.hana, id)).toBeNull();
  });
});

describe("POST /api/drafts: a topic without a title (a short remark)", () => {
  it("creates a draft from a body alone, or from frontmatter without title, or with a null or blank title; publishing it makes a topic without a title", async () => {
    const bodies = ["It was cool this morning.", md("type: post\nlang: en", "Short remark."), md("type: topic\ntitle: null", "Null title."), md("type: topic\ntitle: '   '", "Blank title.")];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.status, body).toBe(201);
      const draft = await getDraft(h.db, h.ids.hana, res.json.id as number);
      expect(draft, body).toMatchObject({ kind: "topic", asksStance: false });
      expect(draft?.title, body).toBeNull();
      const published = await publishDraft(h.db, h.ids.hana, res.json.id as number);
      if (!published.ok) throw new Error(`publish failed: ${published.error}`);
      expect((await h.db.select().from(entries).where(eq(entries.id, published.id)))[0]).toMatchObject({ title: null, kind: "topic", via: "api" });
    }
  });

  it("keeps a title that is there, and refuses a question (asks_stance: true) without one with 400 invalid_title", async () => {
    const withTitle = await post(md("type: topic\ntitle: A title\nlang: en"));
    expect((await getDraft(h.db, h.ids.hana, withTitle.json.id as number))?.title).toBe("A title");
    const question = await post(md("type: topic\nasks_stance: true"));
    expect(question.status).toBe(400);
    expect(question.json.error).toBe("invalid_title");
    expect(String(question.json.message)).toContain("asks_stance");
    expect((await post(md("type: topic\ntitle: ''\nasks_stance: true"))).json.error).toBe("invalid_title");
    expect((await post(md("type: topic\ntitle: T\nasks_stance: true"))).status).toBe(201);
  });
});

describe("POST /api/drafts: validation errors", () => {
  it("returns 400 body_unrenderable without saving a draft when input rendering fails", async () => {
    const beforeDrafts = await h.db.select().from(drafts).orderBy(drafts.id);
    const beforeEntries = await h.db.select().from(entries).orderBy(entries.id);
    const spy = vi.spyOn(markdown, "checkBodyBudget").mockResolvedValue("body_unrenderable");
    try {
      const result = await post(md("type: topic\ntitle: T", "Body text."));
      expect(result.status).toBe(400);
      expect(result.json.error).toBe("body_unrenderable");
      expect(spy).toHaveBeenCalledWith("Body text.", h.ids.hana);
      expect(await h.db.select().from(drafts).orderBy(drafts.id)).toEqual(beforeDrafts);
      expect(await h.db.select().from(entries).orderBy(entries.id)).toEqual(beforeEntries);
    } finally {
      spy.mockRestore();
    }
  });

  // Make the body a function because topic and reply IDs are determined after beforeAll.
  const cases: Array<[string, () => string, string]> = [
    // [error code, body, description]
    ["invalid_frontmatter", () => "---\ntitle: never closed\nbody", "unterminated"],
    ["invalid_frontmatter", () => md("title: [unclosed"), "bad yaml"],
    ["invalid_frontmatter", () => md("title: a\ntitle: b"), "duplicate keys"],
    ["invalid_frontmatter", () => md("a: &x 1\nb: *x"), "anchors and aliases"],
    ["frontmatter_not_object", () => md("- a\n- b"), "list"],
    ["frontmatter_not_object", () => md("just a string"), "string"],
    ["frontmatter_not_object", () => md("42"), "number"],
    ["unknown_type", () => md("type: note\ntitle: T"), "unknown type"],
    ["unknown_type", () => md("type: translation\ntitle: T"), "translation type"],
    ["unknown_type", () => md("type: 5\ntitle: T"), "numeric type"],
    ["unknown_type", () => md("type: __proto__\ntitle: T"), "prototype key as type"],
    ["reply_to_malformed", () => md("reply_to: 5"), "number"],
    ["reply_to_malformed", () => md("reply_to: x-1"), "bad prefix"],
    ["reply_to_malformed", () => md("reply_to: p-0"), "zero"],
    ["reply_to_malformed", () => md("reply_to: c-abc"), "not a number"],
    ["reply_to_malformed", () => md("reply_to: [p-1]"), "list"],
    ["reply_to_malformed", () => md("reply_to: p-99999999999999999999"), "too large"],
    ["reply_to_on_topic", () => md("type: topic\nreply_to: p-1\ntitle: T"), "topic with reply_to"],
    ["reply_to_required", () => md("type: reply"), "reply without reply_to"],
    ["reply_to_not_found", () => md("reply_to: p-999999"), "no such topic"],
    ["reply_to_not_found", () => md("reply_to: c-999999"), "no such reply"],
    ["reply_to_not_found", () => md(`reply_to: c-${topicId}`), "c- pointing at a topic"],
    ["reply_to_not_found", () => md(`reply_to: p-${replyId}`), "p- pointing at a reply"],
    ["invalid_title", () => md("type: topic\nasks_stance: true"), "a question without title"],
    ["invalid_title", () => md("type: topic\ntitle: '   '\nasks_stance: true"), "a question with a blank title"],
    ["invalid_title", () => md(`title: ${"x".repeat(201)}`), "title too long"],
    ["invalid_title", () => md("title: {a: b}"), "title is an object"],
    ["body_required", () => md("title: T", ""), "empty body"],
    ["invalid_lang", () => md("title: T\nlang: xx"), "unknown language"],
    ["invalid_lang", () => md("title: T\nlang: other"), "other is not a language"],
    ["invalid_lang", () => md("title: T\nlang: 5"), "numeric language"],
    ["invalid_ai", () => md("title: T\nai_assistance: full"), "unknown ai"],
    // Questions: asks_stance must be boolean; alt_of must be p-<id> of a visible, undeleted question and requires asks_stance: true; stance_tag is only for replies to questions.
    ["invalid_asks_stance", () => md('title: T\nasks_stance: "true"'), "asks_stance as a string"],
    ["invalid_asks_stance", () => md("title: T\nasks_stance: 1"), "asks_stance as a number"],
    ["invalid_asks_stance", () => md(`reply_to: p-${topicId}\nasks_stance: true`), "a reply that asks for stances"],
    ["invalid_alt_of", () => md("title: T\nasks_stance: true\nalt_of: c-1"), "alt_of pointing at a reply id"],
    ["invalid_alt_of", () => md("title: T\nasks_stance: true\nalt_of: 12"), "alt_of without the p- prefix"],
    ["invalid_alt_of", () => md(`title: T\nasks_stance: true\nalt_of: p-${topicId}`), "alt_of pointing at an ordinary topic"],
    ["invalid_alt_of", () => md("title: T\nasks_stance: true\nalt_of: p-999999"), "alt_of pointing at nothing"],
    ["invalid_alt_of", () => md(`title: T\nalt_of: p-${topicId}`), "alt_of without asks_stance"],
    ["invalid_alt_of", () => md(`reply_to: p-${topicId}\nalt_of: p-${topicId}`), "a reply with alt_of"],
    ["invalid_stance_tag", () => md(`reply_to: p-${topicId}\nstance_tag: agree`), "a mark on a reply to an ordinary topic"],
    ["invalid_stance_tag", () => md("title: T\nstance_tag: agree"), "a mark on a topic"],
    ["invalid_stance_tag", () => md(`reply_to: p-${topicId}\nstance_tag: maybe`), "a mark outside the four values"],
    ["invalid_title", () => md('title: "T\\nsecond line"'), "title with a newline (YAML escape)"],
    ["invalid_title", () => md('title: "T\\u0007bell"'), "title with a control character"],
    ["invalid_title", () => md('title: "T\\0x"'), "title with NUL"],
    ["invalid_title", () => md('title: "a\\u2028b"'), "title with a line separator (U+2028)"],
    ["invalid_title", () => md('title: "a\\u2029b"'), "title with a paragraph separator (U+2029)"],
    ["invalid_title", () => md('title: "a\\x85b"'), "title with NEL (C1 control)"],
    ["invalid_encoding", () => md("title: T", "hello\u0000world"), "NUL in the body"],
    ["invalid_encoding", () => "---\ntitle: T\n---\nx\u0000", "NUL at the end"],
  ];
  it.each(cases.map(([code, body, why]) => [code, why, body] as const))("%s: %s", async (code, _why, body) => {
    void _why;
    const res = await post(body());
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(code);
    expect(typeof res.json.message).toBe("string");
    expect(await h.db.select().from(drafts).where(eq(drafts.title, "never"))).toHaveLength(0);
    // Deeply nested rendering checks can exceed the default five-second timeout under parallel load.
  }, 30_000);

  it("does not create a draft for any of the errors", async () => {
    const count = (await h.db.select().from(drafts)).length;
    for (const [, body] of cases) await post(body());
    expect((await h.db.select().from(drafts)).length).toBe(count);
  }, 30_000);

  it("reports thread_deleted for a reply to a deleted topic or to a reply in a deleted topic, and not_found for a deleted reply", async () => {
    const t = await createTopic(h.db, h.ids.somchai, { lang: "th", title: "ลบ", body: "x" });
    if (!t.ok) throw new Error("topic failed");
    const r = await createReply(h.db, h.ids.somchai, t.id, { lang: "th", body: "y" });
    const r2 = await createReply(h.db, h.ids.somchai, t.id, { lang: "th", body: "z" });
    if (!r.ok || !r2.ok) throw new Error("reply failed");
    await softDeleteEntry(h.db, r2.id);
    expect(await errorOf(md(`reply_to: c-${r2.id}`))).toBe("reply_to_not_found");
    await softDeleteEntry(h.db, t.id);
    expect(await errorOf(md(`reply_to: p-${t.id}`))).toBe("thread_deleted");
    expect(await errorOf(md(`reply_to: c-${r.id}`))).toBe("thread_deleted");
  });

  it("returns 415 for another Content-Type or an unsupported charset, 400 for invalid UTF-8", async () => {
    for (const type of ["application/json", "text/html", "application/x-www-form-urlencoded", "text/plain; charset=iso-8859-1", "multipart/form-data; boundary=x", null]) {
      // Send bytes because string bodies automatically set Content-Type to text/plain.
      const res = await post(new TextEncoder().encode(md("title: T")), { type });
      expect(res.status, String(type)).toBe(415);
      expect(res.json.error).toBe("unsupported_media_type");
    }
    const bad = await post(new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]), { type: "text/markdown" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_encoding");
  });

  it("returns 413 above 256 KiB: by Content-Length without reading, and by counting a body sent without one", async () => {
    expect(MAX_DRAFT_BYTES).toBe(262_144);
    const big = "x".repeat(MAX_DRAFT_BYTES + 1);
    const declared = await post(big);
    expect(declared.status).toBe(413);
    expect(declared.json.error).toBe("payload_too_large");
    // Even a falsely small Content-Length cannot bypass the actual byte count; send a stream.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 300; i++) controller.enqueue(new TextEncoder().encode("y".repeat(1024)));
        controller.close();
      },
    });
    const request = new Request(`${BASE}/api/drafts`, { method: "POST", headers: { authorization: `Bearer ${draftToken}`, "content-type": "text/markdown" }, body: stream, duplex: "half" } as RequestInit);
    const { action } = await import("~/routes/api.drafts");
    const res = (await action({ request, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(413);
    // Exactly 256 KiB passes size validation, then gets 400 from the body-length limit.
    const exact = await post("x".repeat(MAX_DRAFT_BYTES));
    expect(exact.status).toBe(400);
    expect(exact.json.error).toBe("body_too_long");
  });
});

describe("POST /api/drafts: rate limit", () => {
  it("allows 30 drafts an hour per member and rejects another token after the shared cap", async () => {
    const t = await createApiToken(h.db, h.ids.somchai, { name: "limited", kind: "draft" });
    const other = await createApiToken(h.db, h.ids.somchai, { name: "other", kind: "draft" });
    if (!t.ok || !other.ok) throw new Error("token failed");
    // Set the counter to 29 partway through the window.
    const windowMs = 3600 * 1000;
    const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    await h.db.insert(rateLimits).values({ key: `draft:member:${h.ids.somchai}`, windowStart: start, count: 29, expiresAt: new Date(start.getTime() + windowMs) });
    const ok = await post(md("title: Thirty", "x"), { token: t.token, keepLimit: true });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("x-ratelimit-remaining")).toBe("0");
    const limited = await post(md("title: Thirty-one", "x"), { token: t.token, keepLimit: true });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(md("title: Fresh", "x"), { token: other.token, keepLimit: true })).status).toBe(429);
  });
});

describe("POST /api/drafts: pending drafts cap", () => {
  it("refuses to create more drafts once 100 API drafts wait for approval, until one is published or deleted", async () => {
    const t = await createApiToken(h.db, h.ids.somchai, { name: "bulk", kind: "draft" });
    if (!t.ok) throw new Error("token failed");
    expect(MAX_PENDING_API_DRAFTS).toBe(100);
    const have = await countApiDrafts(h.db, h.ids.somchai);
    await h.db.insert(drafts).values(Array.from({ length: MAX_PENDING_API_DRAFTS - have }, (_, i) => ({ authorId: h.ids.somchai, kind: "topic", lang: "th", title: `bulk ${i}`, body: "x", via: "api", tokenId: t.summary.id })));
    const full = await post(md("title: One too many", "x"), { token: t.token });
    expect(full.status).toBe(429);
    expect(full.json.error).toBe("too_many_pending_drafts");
    // Other members are unaffected; deleting a draft permits another.
    expect((await post(md("title: Hana still can", "x"))).status).toBe(201);
    const [one] = await h.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.title, "bulk 0"));
    await h.db.delete(drafts).where(eq(drafts.id, one.id));
    expect((await post(md("title: Room again", "x"), { token: t.token })).status).toBe(201);
    // Do not count UI-created drafts.
    await h.db.insert(drafts).values({ authorId: h.ids.somchai, kind: "topic", lang: "th", title: "web draft", body: "x", via: "web" });
    expect(await countApiDrafts(h.db, h.ids.somchai)).toBe(MAX_PENDING_API_DRAFTS);
  });
});

describe("the badge for drafts sent through the API", () => {
  it("counts only the viewer's pending API drafts and shows up in the header data", async () => {
    const hanaCount = await countApiDrafts(h.db, h.ids.hana);
    expect(hanaCount).toBeGreaterThan(0);
    // Do not count UI-created drafts or other members' drafts.
    const { createDraft } = await import("~/lib/drafts.server");
    await createDraft(h.db, h.ids.hana, { kind: "topic", lang: "ja", title: "web", body: "b" });
    expect(await countApiDrafts(h.db, h.ids.hana)).toBe(hanaCount);
    const layout = await import("~/routes/member-layout");
    const data = (await layout.loader(await h.signedArgs(h.request("/", { as: "hana" })))) as unknown as { apiDrafts: number };
    expect(data.apiDrafts).toBe(hanaCount);
    const somchai = (await layout.loader(await h.signedArgs(h.request("/", { as: "somchai" })))) as unknown as { apiDrafts: number };
    expect(somchai.apiDrafts).toBe(await countApiDrafts(h.db, h.ids.somchai));
    expect(data.apiDrafts).not.toBe(somchai.apiDrafts);
  });
});
