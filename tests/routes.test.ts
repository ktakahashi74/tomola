import { acceptTrialFixture } from "./helpers/trial";
import { draftScreenForm } from "./helpers/draft-form";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as markdown from "~/lib/markdown.server";
import { and, asc, eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import type { Db } from "~/lib/db/client.server";
import { drafts, entries, glossaryEntries, jobs, llmUsage, profiles, translationReports, translations, user } from "~/lib/db/schema";
import { createDraft, getDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { createInvitation } from "~/lib/invitations.server";
import { createProfile } from "~/lib/profiles.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { createTestDb } from "./helpers/db";

const BASE = "http://localhost:5173";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

type G = { __tomolaDb?: Promise<Db>; __tomolaAuth?: Promise<ReturnType<typeof createAuth>> };
const g = globalThis as G;
const saved: G = {};

let db: Db;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

// Create a session through actual login, invitation → magic link, and extract the cookie.
async function signIn(email: string, handle: string) {
  const sent: string[] = [];
  const auth = createAuth(db, {
    baseURL: BASE,
    secret: SECRET,
    sendMagicLink: async ({ url }) => {
      sent.push(url);
    },
  });
  g.__tomolaAuth = Promise.resolve(auth);
  await createInvitation(db, { email });
  await auth.api.signInMagicLink({ body: { email, callbackURL: "/" }, headers: new Headers() });
  const token = new URL(sent.at(-1)!).searchParams.get("token")!;
  const res = await auth.api.magicLinkVerify({ query: { token, callbackURL: "/" }, headers: new Headers(), asResponse: true });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  await createProfile(db, u.id, { handle, homeArea: "ja", readLangs: ["ja"] });
  await acceptTrialFixture(db, u.id);
  cookies[handle] = cookie;
  ids[handle] = u.id;
}

async function request(path: string, opts: { as?: string; form?: Record<string, string> } = {}): Promise<Request> {
  const headers: Record<string, string> = { origin: BASE };
  if (opts.as) headers.cookie = cookies[opts.as];
  const init: RequestInit = { headers };
  if (opts.form) {
    init.method = "POST";
    const match = /^\/drafts\/(\d+)$/.exec(path);
    const form = match && opts.as ? await draftScreenForm(db, ids[opts.as], Number(match[1]), opts.form) : opts.form;
    init.body = new URLSearchParams(form);
  }
  const req = new Request(`${BASE}${path}`, init);
  return req;
}

// Convert thrown route values, redirect Responses and data() errors, into status and destination.
async function outcome(run: () => unknown): Promise<{ status: number; location: string | null; value?: unknown }> {
  try {
    const value = await run();
    if (value instanceof Response) return { status: value.status, location: value.headers.get("location"), value };
    const init = (value as { init?: { status?: number } } | null)?.init;
    return { status: init?.status ?? 200, location: null, value };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("location") };
    const init = (thrown as { init?: { status?: number } }).init;
    if (init) return { status: init.status ?? 500, location: null };
    throw thrown;
  }
}

let topicId: number;
let replyId: number;

beforeAll(async () => {
  saved.__tomolaDb = g.__tomolaDb;
  saved.__tomolaAuth = g.__tomolaAuth;
  db = await createTestDb();
  g.__tomolaDb = Promise.resolve(db);
  await signIn("hana@example.com", "hana");
  await signIn("somchai@example.com", "somchai");
  const topic = await createTopic(db, ids.hana, { lang: "ja", title: "話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;
  const reply = await createReply(db, ids.hana, topicId, { lang: "ja", body: "返信" });
  if (!reply.ok) throw new Error("reply failed");
  replyId = reply.id;
});

afterAll(() => {
  g.__tomolaDb = saved.__tomolaDb;
  g.__tomolaAuth = saved.__tomolaAuth;
});

const args = (req: Request, params: Record<string, string> = {}) => ({ request: req, params, context: {} }) as never;

describe("member-only routes reject visitors who are not logged in", () => {
  it.each([
    ["preview action", () => import("~/routes/preview"), "action", "/preview", {}],
    ["follow action", () => import("~/routes/follow"), "action", "/follow", {}],
    ["following loader", () => import("~/routes/following"), "loader", "/following", {}],
    ["admin-translations loader", () => import("~/routes/admin-translations"), "loader", "/admin/translations", {}],
    ["admin-translations action", () => import("~/routes/admin-translations"), "action", "/admin/translations", {}],
    ["admin-glossary loader", () => import("~/routes/admin-glossary"), "loader", "/admin/glossary", {}],
    ["admin-glossary action", () => import("~/routes/admin-glossary"), "action", "/admin/glossary", {}],
    ["admin-usage loader", () => import("~/routes/admin-usage"), "loader", "/admin/usage", {}],
    ["drafts loader", () => import("~/routes/drafts"), "loader", "/drafts", {}],
    ["draft loader", () => import("~/routes/draft"), "loader", "/drafts/1", { id: "1" }],
    ["draft action", () => import("~/routes/draft"), "action", "/drafts/1", { id: "1" }],
    ["topic-edit loader", () => import("~/routes/topic-edit"), "loader", "/t/1/edit", { id: "1" }],
    ["topic-edit action", () => import("~/routes/topic-edit"), "action", "/t/1/edit", { id: "1" }],
    ["reply-edit loader", () => import("~/routes/reply-edit"), "loader", "/c/1/edit", { id: "1" }],
    ["reply-edit action", () => import("~/routes/reply-edit"), "action", "/c/1/edit", { id: "1" }],
    ["topic-new action", () => import("~/routes/topic-new"), "action", "/t/new", {}],
    ["topic action", () => import("~/routes/topic"), "action", "/t/1", { id: "1" }],
  ] as const)("%s", async (_name, load, kind, path, params) => {
    const mod = (await load()) as unknown as Record<string, (a: never) => unknown>;
    const req = kind === "action" ? await request(path, { form: { body: "x", intent: "save" } }) : await request(path);
    expect(await outcome(async () => mod[kind](args(req, params)))).toMatchObject({ status: 302, location: kind === "loader" ? `/login?next=${encodeURIComponent(path)}` : "/login" });
  });
});

describe("POST /preview", () => {
  it("returns the publication language for automatic, explicit and pasted-language previews", async () => {
    const { action } = await import("~/routes/preview");
    const body = "長い文章を読むときには、言葉の意味を確かめながら考えを追っていく。";
    for (const [form, lang] of [
      [{ body }, "ja"],
      [{ body, lang: "en" }, "en"],
      [{ body: `---\nlang: fr\n---\n${body}`, frontmatter: "topic" }, "fr"],
      [{ body: `---\nlang: fr\n---\n${body}`, frontmatter: "topic", lang: "ja" }, "ja"],
    ] as const) {
      const response = await action(args(await request("/preview", { as: "hana", form }))) as Response;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-language")).toBe(lang);
      expect(await response.text()).toContain(body);
    }
  });
  it("returns the rendered html for a member", async () => {
    const { action } = await import("~/routes/preview");
    const res = (await action(args(await request("/preview", { as: "hana", form: { body: "**bold** $x^2$\r\n\r\ntext[^1]\r\n\r\n[^1]: note" } })))) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('class="katex"');
    // IDs do not collide with footnotes in actual posts.
    expect(html).toContain("preview-");
    expect(html).not.toContain("p-1-");
    // Drop raw HTML.
    const evil = (await action(args(await request("/preview", { as: "hana", form: { body: "<script>alert(1)</script>\n\nhi" } })))) as Response;
    expect(await evil.text()).not.toContain("<script");
  });

  it("returns a rendering failure from the preview as 400 body_unrenderable without saving", async () => {
    const { action } = await import("~/routes/preview");
    const beforeEntries = await db.select().from(entries).orderBy(entries.id);
    const beforeDrafts = await db.select().from(drafts).orderBy(drafts.id);
    const spy = vi.spyOn(markdown, "tryRenderMarkdown").mockResolvedValue(null);
    try {
      const response = await action(args(await request("/preview", { as: "hana", form: { body: "Preview body" } }))) as Response;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "body_unrenderable" });
      expect(spy).toHaveBeenCalledWith("Preview body", expect.any(Object));
      expect(await db.select().from(entries).orderBy(entries.id)).toEqual(beforeEntries);
      expect(await db.select().from(drafts).orderBy(drafts.id)).toEqual(beforeDrafts);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a validation failure from the preview as a 400 JSON response", async () => {
    const { action } = await import("~/routes/preview");
    const tooLong = (await action(args(await request("/preview", { as: "hana", form: { body: "a".repeat(50_001) } })))) as Response;
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "body_too_long" });

  });
});

describe("edit routes enforce the owner on the server", () => {
  it("lets the author open and submit the topic edit form", async () => {
    const { loader, action } = await import("~/routes/topic-edit");
    const data = (await loader(args(await request(`/t/${topicId}/edit`, { as: "hana" }), { id: String(topicId) }))) as {
      entry: { title: string; body: string };
    };
    expect(data.entry).toMatchObject({ title: "話題", body: "本文" });
    const res = await outcome(async () =>
      action(args(await request(`/t/${topicId}/edit`, { as: "hana", form: { title: "直した話題", body: "直した\r\n本文" } }), { id: String(topicId) })),
    );
    expect(res).toMatchObject({ status: 302, location: `/t/${topicId}?edited=${topicId}` });
    const [row] = await db.select().from(entries).where(eq(entries.id, topicId));
    // Normalize form CRLF to LF before saving.
    expect(row).toMatchObject({ title: "直した話題", body: "直した\n本文" });
    expect(row.editedAt).not.toBeNull();
  });

  it("returns 403 to another member, for the loader and the action, and changes nothing", async () => {
    const topicEdit = await import("~/routes/topic-edit");
    const replyEdit = await import("~/routes/reply-edit");
    const [before] = await db.select().from(entries).where(eq(entries.id, topicId));
    const topicParams = { id: String(topicId) };
    const replyParams = { id: String(replyId) };
    expect(await outcome(async () => (await topicEdit.loader(args(await request(`/t/${topicId}/edit`, { as: "somchai" }), topicParams))))).toMatchObject({ status: 403 });
    expect(
      await outcome(async () =>
        topicEdit.action(args(await request(`/t/${topicId}/edit`, { as: "somchai", form: { title: "x", body: "x" } }), topicParams)),
      ),
    ).toMatchObject({ status: 403 });
    expect(await outcome(async () => (await replyEdit.loader(args(await request(`/c/${replyId}/edit`, { as: "somchai" }), replyParams))))).toMatchObject({ status: 403 });
    expect(
      await outcome(async () => replyEdit.action(args(await request(`/c/${replyId}/edit`, { as: "somchai", form: { body: "x" } }), replyParams))),
    ).toMatchObject({ status: 403 });
    const rows = await db.select().from(entries).orderBy(asc(entries.id));
    expect(rows.map((r) => r.body)).toEqual([before.body, "返信"]);
    expect(rows[1].editedAt).toBeNull();
  });

  it("returns 404 when the id is malformed, missing, or of the other kind", async () => {
    const topicEdit = await import("~/routes/topic-edit");
    const replyEdit = await import("~/routes/reply-edit");
    for (const id of ["abc", "0", "1e0", "99999"]) {
      expect(await outcome(async () => (await topicEdit.loader(args(await request(`/t/${id}/edit`, { as: "hana" }), { id }))))).toMatchObject({ status: 404 });
    }
    // A reply ID cannot open topic editing, nor a topic ID reply editing.
    expect(await outcome(async () => (await topicEdit.loader(args(await request("/x", { as: "hana" }), { id: String(replyId) }))))).toMatchObject({ status: 404 });
    expect(await outcome(async () => (await replyEdit.loader(args(await request("/x", { as: "hana" }), { id: String(topicId) }))))).toMatchObject({ status: 404 });
  });

  it("returns the input with the error when validation fails", async () => {
    const { action } = await import("~/routes/reply-edit");
    const res = await outcome(async () =>
      action(args(await request(`/c/${replyId}/edit`, { as: "hana", form: { body: "  " } }), { id: String(replyId) })),
    );
    expect(res.status).toBe(400);
  });
});

describe("web forms normalize newlines and save drafts", () => {
  it("stores a new topic and a reply with LF newlines", async () => {
    const topicNew = await import("~/routes/topic-new");
    const topicRoute = await import("~/routes/topic");
    const posted = await outcome(async () =>
      topicNew.action(args(await request("/t/new", { as: "hana", form: { title: "a b", body: "one\r\n\r\ntwo", lang: "en" } }))),
    );
    expect(posted.status).toBe(302);
    const newId = Number(new URL(posted.location!, BASE).pathname.split("/").pop());
    const [t] = await db.select().from(entries).where(eq(entries.id, newId));
    expect(t.body).toBe("one\n\ntwo");
    expect(t.title).toBe("a b");
    // Titles are one line: reject embedded newlines even after normalization, preventing line breaks in mail subjects and headings.
    const multiline = await outcome(async () =>
      topicNew.action(args(await request("/t/new", { as: "hana", form: { title: "a\r\nb", body: "x", lang: "en" } }))),
    );
    expect(multiline.status).toBe(400);
    const replied = await outcome(async () =>
      topicRoute.action(args(await request(`/t/${newId}`, { as: "somchai", form: { body: "x\r\ny", lang: "en" } }), { id: String(newId) })),
    );
    expect(replied.status).toBe(302);
    const [r] = await db.select().from(entries).where(eq(entries.threadId, newId));
    expect(r.body).toBe("x\ny");
  });

  it("answers 400, without an exception, for a draft with a NUL or a multi-line title (new topic form, reply form, draft page)", async () => {
    const topicNew = await import("~/routes/topic-new");
    const draftRoute = await import("~/routes/draft");
    const nul = String.fromCodePoint(0);
    const before = (await db.select().from(drafts)).length;
    for (const form of [
      { intent: "draft", title: "", body: `a${nul}b`, lang: "ja" },
      { intent: "draft", title: "a\r\nb", body: "x", lang: "ja" },
      { intent: "draft", title: `a${String.fromCodePoint(0x2028)}b`, body: "x", lang: "ja" },
    ]) {
      const res = await outcome(async () => topicNew.action(args(await request("/t/new", { as: "hana", form }))));
      expect(res.status, JSON.stringify(form)).toBe(400);
    }
    expect((await db.select().from(drafts)).length).toBe(before);
    const saved = await createDraft(db, ids.hana, { kind: "topic", lang: "ja", title: "ok", body: "ok" });
    if (!saved.ok) throw new Error("draft failed");
    for (const intent of ["save", "publish"]) {
      for (const form of [{ title: "ok", body: `a${nul}b` }, { title: `a${nul}b`, body: "x" }, { title: "a\nb", body: "x" }]) {
        const res = await outcome(async () =>
          draftRoute.action(args(await request(`/drafts/${saved.id}`, { as: "hana", form: { intent, lang: "ja", aiAssistance: "none", ...form } }), { id: String(saved.id) })),
        );
        expect(res.status, `${intent} ${JSON.stringify(form)}`).toBe(400);
      }
    }
    expect(await getDraft(db, ids.hana, saved.id)).toMatchObject({ title: "ok", body: "ok" });
    // Clean up because other tests count the draft list.
    await db.delete(drafts).where(eq(drafts.id, saved.id));
  });

  it("saves a topic or reply draft instead of posting when asked", async () => {
    const topicNew = await import("~/routes/topic-new");
    const topicRoute = await import("~/routes/topic");
    const before = (await db.select().from(entries)).length;
    const t = await outcome(async () =>
      topicNew.action(args(await request("/t/new", { as: "hana", form: { intent: "draft", title: "", body: "a\r\nb", lang: "ja" } }))),
    );
    expect(t.status).toBe(302);
    expect(t.location).toMatch(/^\/drafts\/\d+\?saved=1$/);
    const r = await outcome(async () =>
      topicRoute.action(args(await request(`/t/${topicId}`, { as: "hana", form: { intent: "draft", body: "", lang: "ja" } }), { id: String(topicId) })),
    );
    expect(r.location).toMatch(/^\/drafts\/\d+$/);
    expect((await db.select().from(entries)).length).toBe(before);
    const rows = await db.select().from(drafts).where(eq(drafts.authorId, ids.hana)).orderBy(asc(drafts.id));
    expect(rows.map((d) => [d.kind, d.body])).toEqual([
      ["topic", "a\nb"],
      ["reply", ""],
    ]);
  });
});

describe("draft routes", () => {
  async function newDraft(as: string, input: Record<string, unknown> = {}) {
    const res = await createDraft(db, ids[as], { kind: "topic", lang: "ja", title: "下書き", body: "本文", ...input });
    if (!res.ok) throw new Error("draft failed");
    return res.id;
  }
  const params = (id: number) => ({ id: String(id) });

  it("shows only my drafts in the list, and 404 for someone else's draft", async () => {
    const draftsRoute = await import("~/routes/drafts");
    const draft = await import("~/routes/draft");
    const mine = await newDraft("hana");
    const list = (await draftsRoute.loader(args(await request("/drafts", { as: "somchai" })))) as { drafts: { id: number }[] };
    expect(list.drafts.map((d) => d.id)).not.toContain(mine);
    expect(await outcome(async () => (await draft.loader(args(await request(`/drafts/${mine}`, { as: "somchai" }), params(mine)))))).toMatchObject({ status: 404 });
    const own = (await draft.loader(args(await request(`/drafts/${mine}`, { as: "hana" }), params(mine)))) as { draft: { id: number } };
    expect(own.draft.id).toBe(mine);
    for (const intent of ["save", "publish", "delete"]) {
      const res = await outcome(async () =>
        draft.action(args(await request(`/drafts/${mine}`, { as: "somchai", form: { intent, title: "x", body: "stolen", lang: "ja" } }), params(mine))),
      );
      expect(res.status).toBe(404);
    }
    const [row] = await db.select().from(drafts).where(eq(drafts.id, mine));
    expect(row.body).toBe("本文");
  });

  it("saves, then publishes what is on the screen, and the draft is gone", async () => {
    const draft = await import("~/routes/draft");
    const id = await newDraft("hana");
    const saved = (await draft.action(
      args(await request(`/drafts/${id}`, { as: "hana", form: { intent: "save", title: "保存した題", body: "保存\r\n本文", lang: "ja" } }), params(id)),
    ));
    expect(saved.data.saved).toBe(true);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
    expect(row).toMatchObject({ title: "保存した題", body: "保存\n本文" });
    const published = await outcome(async () =>
      draft.action(args(await request(`/drafts/${id}`, { as: "hana", form: { intent: "publish", title: "公開した題", body: "公開本文", lang: "ja" } }), params(id))),
    );
    expect(published.status).toBe(302);
    expect(published.location).toMatch(/^\/t\/(\d+)\?posted=\1$/);
    const [entry] = await db.select().from(entries).where(eq(entries.id, Number(new URL(published.location!, BASE).pathname.split("/").pop())));
    expect(entry).toMatchObject({ title: "公開した題", body: "公開本文", authorId: ids.hana });
    expect(await db.select().from(drafts).where(eq(drafts.id, id))).toEqual([]);
  });

  it("keeps the draft, with the new content saved, when publishing fails validation", async () => {
    const draft = await import("~/routes/draft");
    const id = await newDraft("hana");
    const res = await outcome(async () =>
      draft.action(args(await request(`/drafts/${id}`, { as: "hana", form: { intent: "publish", title: "", asksStance: "1", body: "書きかけ", lang: "ja" } }), params(id))),
    );
    // A question needs its title: the draft is kept, with the new content saved.
    expect(res.status).toBe(400);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
    expect(row.body).toBe("書きかけ");
  });

  it("deletes a draft and returns to the list", async () => {
    const draft = await import("~/routes/draft");
    const id = await newDraft("hana");
    const res = await outcome(async () => draft.action(args(await request(`/drafts/${id}`, { as: "hana", form: { intent: "delete" } }), params(id))));
    expect(res).toMatchObject({ status: 302, location: "/drafts" });
    expect(await db.select().from(drafts).where(eq(drafts.id, id))).toEqual([]);
  });

  it("publishes a reply draft to the thread", async () => {
    const draft = await import("~/routes/draft");
    const id = await newDraft("somchai", { kind: "reply", threadId: topicId, title: undefined, body: "返信の下書き" });
    const res = await outcome(async () =>
      draft.action(args(await request(`/drafts/${id}`, { as: "somchai", form: { intent: "publish", body: "返信の下書き", lang: "ja", version: "1" } }), params(id))),
    );
    expect(res.status).toBe(302);
    const published = new URL(res.location!, "http://localhost");
    expect(published.pathname).toBe(`/t/${topicId}`);
    expect(published.searchParams.get("posted")).toMatch(/^[1-9]\d*$/);
    expect(published.hash).toBe(`#c-${published.searchParams.get("posted")}`);
  });
});

describe("/admin/usage is for operators only (OPERATOR_EMAILS)", () => {
  const saved = process.env.OPERATOR_EMAILS;
  const savedBudget = process.env.LLM_MONTHLY_BUDGET_USD;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterEach(async () => {
    restore("OPERATOR_EMAILS", saved);
    restore("LLM_MONTHLY_BUDGET_USD", savedBudget);
    await db.delete(llmUsage);
  });

  type UsageData = {
    month: string;
    state: string;
    usedMicro: number;
    budgetMicro: number;
    rows: Array<{ engine: string; costMicro: number }>;
    failedJobs: Array<{ kind: string; count: number }>;
  };

  it("returns 404 to members who are not operators, including when OPERATOR_EMAILS is unset", async () => {
    const { loader } = await import("~/routes/admin-usage");
    process.env.OPERATOR_EMAILS = "";
    expect(await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))))).toMatchObject({ status: 404 });
    process.env.OPERATOR_EMAILS = "hana@example.com";
    expect(await outcome(async () => (await loader(args(await request("/admin/usage", { as: "somchai" })))))).toMatchObject({ status: 404 });
    // Partial matches do not pass.
    process.env.OPERATOR_EMAILS = "xhana@example.com,hana@example.com.evil";
    expect(await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))))).toMatchObject({ status: 404 });
  });

  it("shows the month, the budget and the state to an operator (email compared case-insensitively)", async () => {
    const { loader } = await import("~/routes/admin-usage");
    process.env.OPERATOR_EMAILS = " SOMEONE@else.example , HANA@Example.COM ";
    process.env.LLM_MONTHLY_BUDGET_USD = "10";
    const res = await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))));
    expect(res.status).toBe(200);
    const normal = res.value as UsageData;
    expect(normal).toMatchObject({ state: "normal", usedMicro: 0, budgetMicro: 10_000_000, rows: [] });
    expect(normal.month).toMatch(/^\d{4}-\d{2}$/);

    await db.insert(llmUsage).values([
      { engine: "gemini", model: "gemini-2.5-flash-lite", purpose: "translate", inputTokens: 10, outputTokens: 10, costUsdMicro: 8_500_000 },
    ]);
    const degraded = (await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))))).value as UsageData;
    expect(degraded).toMatchObject({ state: "degraded", usedMicro: 8_500_000, rows: [{ engine: "gemini", costMicro: 8_500_000 }] });
    await db.insert(llmUsage).values({ engine: "claude", model: "claude-haiku-4-5", purpose: "judge", costUsdMicro: 1_500_000 });
    const stopped = (await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))))).value as UsageData;
    expect(stopped).toMatchObject({ state: "stopped", usedMicro: 10_000_000 });
  });

  it("lists the number of failed jobs per kind", async () => {
    const { loader } = await import("~/routes/admin-usage");
    process.env.OPERATOR_EMAILS = "hana@example.com";
    expect(((await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))))).value as UsageData).failedJobs).toEqual([]);
    await db.insert(jobs).values([
      { kind: "translate_entry", status: "failed", lastError: "refusal" },
      { kind: "translate_entry", status: "failed", lastError: "x" },
      { kind: "measure_divergence", status: "failed" },
      { kind: "translate_entry", status: "done" },
    ]);
    const data = (await outcome(async () => (await loader(args(await request("/admin/usage", { as: "hana" })))))).value as UsageData;
    expect(data.failedJobs).toEqual([
      { kind: "measure_divergence", count: 1 },
      { kind: "translate_entry", count: 2 },
    ]);
    await db.delete(jobs).where(eq(jobs.status, "failed"));
  });

  it("tells the layout whether to show the link", async () => {
    const { loader } = await import("~/routes/member-layout");
    process.env.OPERATOR_EMAILS = "hana@example.com";
    expect((await outcome(async () => (await loader(args(await request("/", { as: "hana" })))))).value).toMatchObject({ isOperator: true });
    expect((await outcome(async () => (await loader(args(await request("/", { as: "somchai" })))))).value).toMatchObject({ isOperator: false });
  });
});

describe("resource routes refuse cross-site POSTs (CSRF)", () => {
  const crossSite = (path: string, as: string, form: Record<string, string>, headers: Record<string, string>) =>
    new Request(`${BASE}${path}`, { method: "POST", headers: { cookie: cookies[as], ...headers }, body: new URLSearchParams(form) });

  it("/settings: a foreign Origin gets 403 and language preferences are not changed", async () => {
    const { action } = await import("~/routes/settings");
    const before = (await db.select().from(profiles).where(eq(profiles.userId, ids.hana)))[0].displayLang;
    for (const headers of [{ origin: "http://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, {}] as Array<Record<string, string>>) {
      const res = await outcome(async () => action(args(crossSite("/settings", "hana", { intent: "preferences", homeArea: "ja", readLangs: "ja", displayLang: "vi" }, headers))));
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect((await db.select().from(profiles).where(eq(profiles.userId, ids.hana)))[0].displayLang).toBe(before);
    // The same origin, via Origin or Sec-Fetch-Site, passes.
    expect((await outcome(async () => action(args(crossSite("/settings", "hana", { intent: "preferences", homeArea: "ja", readLangs: "ja", displayLang: "vi" }, { origin: BASE }))))).status).toBe(302);
    expect((await outcome(async () => action(args(crossSite("/settings", "hana", { intent: "preferences", homeArea: "ja", readLangs: "ja", displayLang: "fr" }, { "sec-fetch-site": "same-origin" }))))).status).toBe(302);
    expect((await db.select().from(profiles).where(eq(profiles.userId, ids.hana)))[0].displayLang).toBe("fr");
    await db.update(profiles).set({ displayLang: null }).where(eq(profiles.userId, ids.hana));
  });

  it("/preview: a foreign Origin gets 403 before anything is rendered, even with a valid session", async () => {
    const { action } = await import("~/routes/preview");
    for (const headers of [{ origin: "http://evil.example" }, { "sec-fetch-site": "cross-site" }, {}] as Array<Record<string, string>>) {
      const res = await outcome(async () => action(args(crossSite("/preview", "hana", { body: "**x**" }, headers))));
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    const ok = (await action(args(crossSite("/preview", "hana", { body: "**x**" }, { origin: BASE })))) as Response;
    expect(ok.status).toBe(200);
  });

  it("checks the origin before the login: a foreign visitor without a session also gets 403, not a redirect", async () => {
    const { action } = await import("~/routes/settings");
    const res = await outcome(async () =>
      action(args(new Request(`${BASE}/settings`, { method: "POST", headers: { origin: "http://evil.example" }, body: new URLSearchParams({ intent: "preferences", homeArea: "ja", readLangs: "ja", displayLang: "fr" }) }))),
    );
    expect(res.status).toBe(403);
  });
});

describe("translation display in the routes", () => {
  type EntryData = {
    id: number;
    display: { shown: string; pending: boolean; translation: { lang: string; kind: string; engine: string | null; html: string; title: { text: string } | null } | null };
  };
  type ThreadData = { topic: EntryData; replies: EntryData[]; displayLang: string };
  let newTopic: number;
  let newReply: number;

  async function translate() {
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { logger: { error: () => {}, warn: () => {} }, limit: 500 });
  }

  it("prepares a th-only reader and a translated thread", async () => {
    await db.update(profiles).set({ readLangs: ["th"] }).where(eq(profiles.userId, ids.somchai));
    const t = await createTopic(db, ids.hana, { lang: "ja", title: "翻訳の題", body: "翻訳の本文" });
    if (!t.ok) throw new Error("topic failed");
    newTopic = t.id;
    const r = await createReply(db, ids.hana, newTopic, { lang: "ja", body: "翻訳の返信" });
    if (!r.ok) throw new Error("reply failed");
    newReply = r.id;
    await translate();
  });

  it("shows the reader's display-language translation by default, and the original to a reader of the original language", async () => {
    const topicRoute = await import("~/routes/topic");
    const th = (await topicRoute.loader(args(await request(`/t/${newTopic}`, { as: "somchai" }), { id: String(newTopic) }))) as ThreadData;
    expect(th.displayLang).toBe("en");
    expect(th.topic.display).toMatchObject({ shown: "translation", pending: false });
    expect(th.topic.display.translation).toMatchObject({ lang: "en", kind: "primary", engine: "fake" });
    expect(th.topic.display.translation?.title?.text).toBe("[en] 翻訳の題");
    expect(th.replies[0].display.translation?.html).toContain("[en] 翻訳の返信");
    // Without a page override, original-reading preferences still select the source.
    const usual = (await topicRoute.loader(args(await request(`/t/${newTopic}`, { as: "hana" }), { id: String(newTopic) }))) as ThreadData;
    expect(usual.topic.display.shown).toBe("original");
    // An explicit page language selects its translation even for a Japanese reader.
    const ja = (await topicRoute.loader(args(await request(`/t/${newTopic}?lang=th`, { as: "hana" }), { id: String(newTopic) }))) as ThreadData;
    expect(ja.topic.display.shown).toBe("translation");
    expect(ja.topic.display.translation).toMatchObject({ lang: "th" });
  });

  it("?orig=<id> shows the original of that entry without JavaScript, ?tr=<id> the translation, ?lang= overrides the page", async () => {
    const topicRoute = await import("~/routes/topic");
    const params = { id: String(newTopic) };
    const orig = (await topicRoute.loader(args(await request(`/t/${newTopic}?orig=${newReply}`, { as: "somchai" }), params))) as ThreadData;
    expect(orig.topic.display.shown).toBe("translation");
    expect(orig.replies[0].display.shown).toBe("original");
    expect(orig.replies[0].display.translation).not.toBeNull();
    const tr = (await topicRoute.loader(args(await request(`/t/${newTopic}?lang=ja&tr=${newTopic}`, { as: "hana" }), params))) as ThreadData;
    expect(tr.displayLang).toBe("ja");
    const en = (await topicRoute.loader(args(await request(`/t/${newTopic}?lang=en`, { as: "somchai" }), params))) as ThreadData;
    expect(en.displayLang).toBe("en");
    expect(en.topic.display.translation).toMatchObject({ lang: "en" });
    // ?lang= affects only this page and does not change the saved display language.
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, ids.somchai));
    expect(p.displayLang).toBeNull();
  });

  it("lists translated titles on the latest page and passes ?lang= on to the thread links", async () => {
    const latest = await import("~/routes/latest");
    const data = (await latest.loader(args(await request("/latest", { as: "somchai" })))) as {
      langParam: string | null;
      topics: Array<{ id: number; title: { text: string; lang: string; kind: string | null } }>;
    };
    const row = data.topics.find((t) => t.id === newTopic)!;
    expect(row.title).toMatchObject({ text: "[en] 翻訳の題", lang: "en", kind: "primary" });
    expect(data.langParam).toBeNull();
    const ja = (await latest.loader(args(await request("/latest", { as: "hana" })))) as typeof data;
    expect(ja.topics.find((t) => t.id === newTopic)!.title).toMatchObject({ text: "翻訳の題", lang: "ja", kind: null });
    const en = (await latest.loader(args(await request("/latest?lang=en", { as: "somchai" })))) as typeof data;
    expect(en.langParam).toBe("en");
    expect(en.topics.find((t) => t.id === newTopic)!.title).toMatchObject({ text: "[en] 翻訳の題", lang: "en" });
  });

  it("saves translation preferences in settings and rejects invalid languages", async () => {
    const { action } = await import("~/routes/settings");
    const topicRoute = await import("~/routes/topic");
    const res = await outcome(async () => action(args(await request("/settings", { as: "somchai", form: { intent: "preferences", homeArea: "ja", readLangs: "th", displayLang: "fr" } }))));
    expect(res).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, ids.somchai));
    expect(p.displayLang).toBe("fr");
    const thread = await topicRoute.loader(args(await request(`/t/${newTopic}`, { as: "somchai" }), { id: String(newTopic) })) as ThreadData;
    expect(thread.displayLang).toBe("fr");
    const override = await topicRoute.loader(args(await request(`/t/${newTopic}?lang=ko`, { as: "somchai" }), { id: String(newTopic) })) as ThreadData;
    expect(override.displayLang).toBe("ko");
    const bad = await outcome(async () => action(args(await request("/settings", { as: "somchai", form: { intent: "preferences", homeArea: "ja", readLangs: "th", displayLang: "xx" } }))));
    expect(bad.status).toBe(400);
    expect((await db.select().from(profiles).where(eq(profiles.userId, ids.somchai)))[0].displayLang).toBe("fr");
    await db.update(profiles).set({ displayLang: null }).where(eq(profiles.userId, ids.somchai));
  });

  it("?old=<id> shows the translation of an older version (a stale human translation) once a new primary exists", async () => {
    const topicRoute = await import("~/routes/topic");
    const params = { id: String(newTopic) };
    await db.insert(translations).values({
      entryId: newTopic,
      field: "body",
      lang: "th",
      kind: "human",
      text: "คนแก้ไขแล้ว",
      sourceHash: (await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, newTopic)))[0].h,
      createdBy: ids.hana,
    });
    await editEntry(db, ids.hana, newTopic, { title: "翻訳の題", body: "直した翻訳の本文" });
    await translate();
    const normal = (await topicRoute.loader(args(await request(`/t/${newTopic}?lang=th`, { as: "somchai" }), params))) as ThreadData & {
      topic: EntryData & { display: { translation: { older: { kind: string; html: string } | null } | null } };
    };
    expect(normal.topic.display.shown).toBe("translation");
    expect(normal.topic.display.translation).toMatchObject({ kind: "primary", older: { kind: "human" } });
    expect(normal.topic.display.translation?.html).toContain("[th] 直した翻訳の本文");
    expect(normal.topic.display.translation?.older?.html).toBeNull();
    expect(JSON.stringify(normal)).not.toContain("คนแก้ไขแล้ว");
    const older = (await topicRoute.loader(args(await request(`/t/${newTopic}?lang=th&old=${newTopic}`, { as: "somchai" }), params))) as typeof normal;
    expect(older.topic.display.shown).toBe("older");
    expect(older.topic.display.translation?.older?.html).toContain("คนแก้ไขแล้ว");
    // Remove this human-correction row so it does not affect the later operator-correction test.
    await db.delete(translations).where(and(eq(translations.entryId, newTopic), eq(translations.kind, "human")));
  });
});

describe("translation reports and the operator pages", () => {
  let topicId2: number;
  let replyId2: number;
  const saved = process.env.OPERATOR_EMAILS;
  const params = (id: number) => ({ id: String(id) });

  it("prepares a thread", async () => {
    const t = await createTopic(db, ids.hana, { lang: "ja", title: "報告の題", body: "報告の本文" });
    if (!t.ok) throw new Error("topic failed");
    topicId2 = t.id;
    const r = await createReply(db, ids.hana, topicId2, { lang: "ja", body: "報告の返信" });
    if (!r.ok) throw new Error("reply failed");
    replyId2 = r.id;
  });

  it("takes a mistranslation report from a member on a thread entry, and rejects others", async () => {
    const topicRoute = await import("~/routes/topic");
    const report = (as: string, form: Record<string, string>) =>
      outcome(async () => topicRoute.action(args(await request(`/t/${topicId2}`, { as, form: { intent: "report", ...form } }), params(topicId2))));
    const ok = await report("somchai", { entryId: String(replyId2), lang: "th", field: "body", excerpt: "แปลผิด", note: "should be X" });
    expect(ok.status).toBe(200);
    expect(ok.value).toMatchObject({ data: { intent: "report", reported: true } });
    const [row] = await db.select().from(translationReports);
    expect(row).toMatchObject({ entryId: replyId2, lang: "th", field: "body", reporterId: ids.somchai, status: "open" });
    // One click without a location or explanation can submit a report. A second click by the same member creates no row. Title reports apply only to topic titles.
    expect((await report("somchai", { entryId: String(topicId2), lang: "th", field: "title", excerpt: "", note: "" })).status).toBe(200);
    expect((await report("somchai", { entryId: String(topicId2), lang: "th", field: "title", excerpt: "", note: "" })).value).toMatchObject({ data: { intent: "report", reported: true } });
    expect((await report("somchai", { entryId: String(replyId2), lang: "th", field: "title", excerpt: "", note: "" })).status).toBe(400);
    // Not an entry in this thread: another thread's entry, a nonexistent ID, or a nonnumeric ID.
    expect((await report("somchai", { entryId: String(topicId), lang: "th", field: "body", excerpt: "x", note: "" })).status).toBe(404);
    expect((await report("somchai", { entryId: "999999", lang: "th", field: "body", excerpt: "x", note: "" })).status).toBe(404);
    expect((await report("somchai", { entryId: "abc", lang: "th", field: "body", excerpt: "x", note: "" })).status).toBe(404);
    expect(await db.select().from(translationReports)).toHaveLength(2);
    // Remove the title-report row for the later operator-list test.
    await db.delete(translationReports).where(eq(translationReports.entryId, topicId2));
    expect(await db.select().from(translationReports)).toHaveLength(1);
  });

  it("hides the operator pages (404) from members who are not operators", async () => {
    process.env.OPERATOR_EMAILS = "";
    const trans = await import("~/routes/admin-translations");
    const gloss = await import("~/routes/admin-glossary");
    expect(await outcome(async () => (await trans.loader(args(await request("/admin/translations", { as: "hana" })))))).toMatchObject({ status: 404 });
    expect(await outcome(async () => trans.action(args(await request("/admin/translations", { as: "hana", form: { reportId: "1", text: "x" } }))))).toMatchObject({ status: 404 });
    expect(await outcome(async () => (await gloss.loader(args(await request("/admin/glossary", { as: "hana" })))))).toMatchObject({ status: 404 });
    expect(await outcome(async () => gloss.action(args(await request("/admin/glossary", { as: "hana", form: { intent: "create", term: "x", lang: "ja", targetLang: "en" } }))))).toMatchObject({ status: 404 });
    expect(await db.select().from(glossaryEntries)).toHaveLength(0);
    expect(await db.select().from(translationReports).where(eq(translationReports.status, "resolved"))).toHaveLength(0);
  });

  it("lets an operator resolve a report with a human translation (or dismiss it)", async () => {
    process.env.OPERATOR_EMAILS = "hana@example.com";
    const route = await import("~/routes/admin-translations");
    const list = (await route.loader(args(await request("/admin/translations", { as: "hana" })))) as { reports: Array<{ id: number; entryId: number; lang: string }> };
    expect(list.reports).toHaveLength(1);
    const report = list.reports[0];
    expect(report).toMatchObject({ entryId: replyId2, lang: "th" });
    const bad = await outcome(async () => route.action(args(await request("/admin/translations", { as: "hana", form: { reportId: String(report.id), text: "  " } }))));
    expect(bad.status).toBe(400);
    const res = await outcome(async () =>
      route.action(args(await request("/admin/translations", { as: "hana", form: { reportId: String(report.id), text: "แก้แล้ว\r\nบรรทัดสอง" } }))),
    );
    expect(res).toMatchObject({ status: 302, location: "/admin/translations" });
    const [human] = await db.select().from(translations).where(eq(translations.kind, "human"));
    expect(human).toMatchObject({ entryId: replyId2, lang: "th", field: "body", text: "แก้แล้ว\nบรรทัดสอง", createdBy: ids.hana });
    const [row] = await db.select().from(translationReports).where(eq(translationReports.id, report.id));
    expect(row).toMatchObject({ status: "resolved", resolvedBy: ids.hana });
    expect(((await route.loader(args(await request("/admin/translations", { as: "hana" })))) as { reports: unknown[] }).reports).toEqual([]);
    // Close only.
    const again = await createTranslationReport(db, ids.somchai, { entryId: replyId2, lang: "fr", field: "body", excerpt: "x", note: "" });
    if (!again.ok) throw new Error("report failed");
    const dismissed = await outcome(async () => route.action(args(await request("/admin/translations", { as: "hana", form: { reportId: String(again.id), intent: "dismiss" } }))));
    expect(dismissed).toMatchObject({ status: 302, location: "/admin/translations" });
    expect((await db.select().from(translations).where(eq(translations.kind, "human"))).length).toBe(1);
    // Resolving an already resolved report changes nothing and returns to the list.
    const repeat = await outcome(async () => route.action(args(await request("/admin/translations", { as: "hana", form: { reportId: String(report.id), text: "again" } }))));
    expect(repeat).toMatchObject({ status: 302, location: "/admin/translations" });
    expect((await db.select().from(translations).where(eq(translations.kind, "human")))[0].text).toBe("แก้แล้ว\nบรรทัดสอง");
  });

  it("lets an operator add, edit and delete glossary entries, rejecting bad input", async () => {
    process.env.OPERATOR_EMAILS = "hana@example.com";
    const route = await import("~/routes/admin-glossary");
    const create = (form: Record<string, string>) => outcome(async () => route.action(args(await request("/admin/glossary", { as: "hana", form }))));
    const made = await create({ intent: "create", term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment\r\nconsistency", note: "AI", keepOriginal: "on" });
    const [row] = await db.select().from(glossaryEntries);
    // On success, return to the item anchor #g-<id>.
    expect(made).toMatchObject({ status: 302, location: `/admin/glossary#g-${row.id}` });
    expect(row).toMatchObject({ term: "整合性", candidates: ["alignment", "consistency"], note: "AI", keepOriginal: true, updatedBy: ids.hana });
    const dup = await create({ intent: "create", term: "整合性", lang: "ja", targetLang: "en" });
    expect(dup.status).toBe(400);
    expect((await create({ intent: "create", term: "", lang: "ja", targetLang: "en" })).status).toBe(400);
    const edited = await create({ intent: "update", id: String(row.id), term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment" });
    expect(edited).toMatchObject({ status: 302 });
    const [after] = await db.select().from(glossaryEntries);
    expect(after).toMatchObject({ candidates: ["alignment"], keepOriginal: false });
    // Saving again with nothing changed: no history, no proposal recorded, and the row says so (a notice, not a redirect that looks like a success)
    const unchanged = await create({ intent: "update", id: String(row.id), term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment", proposal: String(topicId) });
    expect(unchanged).toMatchObject({ status: 200, location: null });
    expect((unchanged.value as { data: unknown }).data).toEqual({ notice: "unchanged", row: String(row.id) });
    const list = (await route.loader(args(await request("/admin/glossary", { as: "hana" })))) as { entries: unknown[] };
    expect(list.entries).toHaveLength(1);
    expect(await create({ intent: "delete", id: String(row.id) })).toMatchObject({ status: 302, location: "/admin/glossary" });
    // Deletion keeps the row, sets deleted_at, and omits it from the list.
    expect(await db.select().from(glossaryEntries)).toHaveLength(1);
    expect((await db.select().from(glossaryEntries))[0].deletedAt).toBeInstanceOf(Date);
    expect(((await route.loader(args(await request("/admin/glossary", { as: "hana" })))) as { entries: unknown[] }).entries).toHaveLength(0);
    process.env.OPERATOR_EMAILS = saved;
  });
});
