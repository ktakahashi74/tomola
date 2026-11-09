import { draftScreenForm } from "./helpers/draft-form";
import { desc, eq } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDraft } from "~/lib/drafts.server";
import { entries, jobs, profiles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { hitMemberLimit, MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { messageMarkup } from "./helpers/message-markup";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

// Dedicated publication retains frontmatter validation, writer gates and shared rate limits.
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("john", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("kim", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("sus", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("fast", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("slow", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("drafty", { homeArea: "ja", readLangs: ["ja"] });
});
afterAll(() => h.restore());
afterEach(() => vi.unstubAllEnvs());

const editor = () => import("~/routes/topic-new");
const home = () => import("~/routes/home");
const post = async (as: string, form: Record<string, string>, headers?: Record<string, string>) => {
  const { action } = await editor();
  return h.outcome(async () => action(await h.signedArgs(h.request("/t/new", { as, form, headers }))));
};
const rowOf = async (id: number) => (await h.db.select().from(entries).where(eq(entries.id, id)))[0];
const idFrom = (location: string | null) => Number(new URL(location ?? "/", "http://localhost").searchParams.get("posted"));
const errorOf = (outcome: Awaited<ReturnType<typeof post>>) => (outcome.value as { data: { error: string; values: Record<string, unknown> } }).data;
const topicCount = async () => (await h.db.select().from(entries).where(eq(entries.kind, "topic"))).length;

describe("a post with a body only", () => {
  it("makes a topic without a title, in the main language of the member, and opens the published topic", async () => {
    const out = await post("hana", { body: "短い発言です。" });
    expect(out.status).toBe(302);
    const id = idFrom(out.location);
    expect(id).toBeGreaterThan(0);
    expect(await rowOf(id)).toMatchObject({ kind: "topic", title: null, body: "短い発言です。", lang: "ja", asksStance: false, authorId: h.ids.hana, via: "web", aiAssistance: null, altOf: null });
    // john's main language is English: his default language is that
    const john = idFrom((await post("john", { body: "A short remark." })).location);
    expect(await rowOf(john)).toMatchObject({ title: null, lang: "en", aiAssistance: null });
    // the empty values of the options (what the form sends when they are left alone) are the defaults
    const plain = idFrom((await post("hana", { body: "オプションは空のまま。", title: "", lang: "" })).location);
    expect(await rowOf(plain)).toMatchObject({ title: null, lang: "ja", asksStance: false });
  });

  it("the new topic is the first row of the home, a translation job is queued, and the member sees the row they just wrote", async () => {
    const out = await post("hana", { body: "いちばん上に出る発言。" });
    const id = idFrom(out.location);
    const { loader } = await home();
    const data = (await loader(await h.signedArgs(h.request("/", { as: "kim" })))) as unknown as { topics: Array<{ id: number }> };
    expect(data.topics[0].id).toBe(id);
    const queued = await h.db.select().from(jobs).orderBy(desc(jobs.id));
    expect(queued.some((j) => j.kind === "translate_entry" && (j.payload as { entryId?: number }).entryId === id)).toBe(true);
  });

  it("adds a title, asks for stances and sets the language when the options are used", async () => {
    const q = idFrom((await post("hana", { body: "条件です。", title: "AIは協力できるか", asksStance: "1", lang: "en" })).location);
    expect(await rowOf(q)).toMatchObject({ title: "AIは協力できるか", asksStance: true, lang: "en" });
    const titled = idFrom((await post("hana", { body: "題つきの投稿。", title: "  題  " })).location);
    expect(await rowOf(titled)).toMatchObject({ title: "題", asksStance: false });
  });

  it("normalizes the line breaks of the form, as the screen of a new post does", async () => {
    const id = idFrom((await post("hana", { body: "一行目\r\n二行目" })).location);
    expect((await rowOf(id)).body).toBe("一行目\n二行目");
  });

  it("reads a frontmatter pasted at the start of the body exactly as /t/new does (title, language, asks_stance, ai_assistance), and the typed values win", async () => {
    const pasted = "---\ntitle: 貼り付けた題\nlang: en\nasks_stance: true\nai_assistance: polish\n---\n本文です。";
    const viaEditor = idFrom((await post("hana", { body: pasted })).location);
    const { action } = await import("~/routes/topic-new");
    const outcome = await h.outcome(async () => action(await h.signedArgs(h.request("/t/new", { as: "hana", form: { body: pasted } }))));
    expect(outcome.status).toBe(302);
    const viaNew = Number(new URL(outcome.location!, "http://localhost").searchParams.get("posted"));
    const strip = (r: Awaited<ReturnType<typeof rowOf>>) => ({ title: r.title, body: r.body, lang: r.lang, asksStance: r.asksStance, aiAssistance: r.aiAssistance, altOf: r.altOf, via: r.via });
    expect(strip(await rowOf(viaEditor))).toEqual(strip(await rowOf(viaNew)));
    expect(strip(await rowOf(viaEditor))).toEqual({ title: "貼り付けた題", body: "本文です。", lang: "en", asksStance: true, aiAssistance: "polish", altOf: null, via: "web" });
    // the typed title and language win over the pasted ones
    const typed = idFrom((await post("hana", { body: pasted, title: "打った題", lang: "ja" })).location);
    expect(await rowOf(typed)).toMatchObject({ title: "打った題", lang: "ja" });
    // a frontmatter of the wrong kind or a broken one is refused with the same classes as /t/new
    expect(errorOf(await post("hana", { body: "---\ntype: reply\nreply_to: p-1\n---\nx" })).error).toBe("frontmatter_type_mismatch");
    expect(errorOf(await post("hana", { body: "---\nlang: xx\n---\nx" })).error).toBe("frontmatter_invalid");
  });

  it("gives a topic with a pasted title the same as the typed one: a question whose title is in the frontmatter is accepted", async () => {
    const id = idFrom((await post("hana", { body: "---\ntitle: 題はfrontmatterに\n---\n本文", asksStance: "1" })).location);
    expect(await rowOf(id)).toMatchObject({ title: "題はfrontmatterに", asksStance: true });
  });
});

describe("mistakes: the words, what was typed and the opened options come back", () => {
  it("refuses a question without a title with invalid_title, creates nothing, and hands back the text, the title, the box and the language", async () => {
    const before = await topicCount();
    const out = await post("hana", { body: "書いた本文。", title: "", asksStance: "1", lang: "en" });
    expect(out.status).toBe(400);
    expect(errorOf(out)).toEqual({ error: "invalid_title", values: { body: "書いた本文。", title: "", asksStance: true, lang: "en", intro: false } });
    expect(await topicCount()).toBe(before);
  });

  it("returns an empty-body failure and refuses unavailable languages", async () => {
    const empty = await post("hana", { body: "   \n ", title: "題だけ" });
    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toMatchObject({ error: "body_required" });
    expect(errorOf(await post("hana", { body: "x", lang: "xx" }))).toMatchObject({ error: "invalid_lang" });
    // a language that exists but is not enabled on this site is refused the same way
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(errorOf(await post("hana", { body: "x", lang: "fr" })).error).toBe("invalid_lang");
    expect((await post("hana", { body: "x", lang: "en" })).status).toBe(302);
  });

  it("retains question fields in the dedicated editor after a title error", async () => {
    const { default: TopicNew, loader } = await editor();
    const base = await loader(h.args(h.request("/t/new", { as: "hana" })));
    const draw = (body: string) => renderInRouter(() => createElement(TopicNew as never, {
      loaderData: base, actionData: { error: "invalid_title", values: { body, title: "", asksStance: true, lang: "en", intro: false } }, params: {}, matches: [],
    } as never), "/t/new");
    const mistake = await draw("残る本文");
    expect(mistake).toContain("残る本文</textarea>");
    // A refused question keeps the checkbox selected.
    expect((mistake.match(/<input[^>]*name="asksStance"[^>]*>/g) ?? []).find(tag => tag.includes('checked=""'))).toContain('value="1"');
    expect(mistake).toMatch(/<input[^>]*name="lang"[^>]*value="en"/);
    expect(mistake.match(/<input[^>]*name="title"[^>]*>/)![0]).toContain('required=""');
    expect(mistake).toContain(messageMarkup(m.field_title_required()));
    const pasted = await draw("---\nlang: en\n---\n本文");
    const title = pasted.match(/<input[^>]*name="title"[^>]*>/)![0];
    expect(title).not.toContain('required=""');
    expect(title).toContain('aria-required="true"');
    expect(pasted).toContain(messageMarkup(m.field_title_required()));
    expect(mistake).not.toContain('value="collapse"');
  });
});

describe("reading works without JavaScript and writing has no AI field", () => {
  it("offers the introduction checkbox only at its entry point and preserves a refused introduction", async () => {
    const { default: TopicNew, loader } = await editor();
    const draw = async (url: string, actionData?: unknown) => {
      const base = await loader(h.args(h.request(url, { as: "hana" })));
      return renderInRouter(() => createElement(TopicNew as never, { loaderData: base, actionData, params: {}, matches: [] } as never), url);
    };
    expect(await draw("/t/new")).not.toMatch(/<input[^>]*name="intro"/);
    expect(await draw("/t/new?intro=0")).not.toMatch(/<input[^>]*name="intro"/);
    const introduction = await draw("/t/new?intro=1");
    expect(introduction.match(/<input[^>]*name="intro"[^>]*>/)![0]).toContain('checked=""');
    const refused = await draw("/t/new?intro=1", { error: "invalid_intro", values: { title: "", body: "Retained introduction", lang: "ja", asksStance: false, intro: true } });
    expect(refused.match(/<input[^>]*name="intro"[^>]*>/)![0]).toContain('checked=""');
    expect(refused).toContain("Retained introduction</textarea>");
  });

  it("names the title field by its placeholder instead of a label and help text, and says the question part only for a question", async () => {
    const { default: TopicNew, loader } = await editor();
    const base = await loader(h.args(h.request("/t/new", { as: "hana" })));
    const html = await renderInRouter(() => createElement(TopicNew as never, { loaderData: base, params: {}, matches: [] } as never), "/t/new");
    const field = html.match(/<input[^>]*name="title"[^>]*>/)![0];
    expect(field).toContain(`aria-label="${messageMarkup(m.field_title())}"`);
    expect(field).toContain(`placeholder="${messageMarkup(m.field_title())}"`);
    // The lock explanation belongs to a question: not drawn for an ordinary post.
    expect(html).not.toContain(messageMarkup(m.asks_stance_help()));
    const { TitleField } = await import("~/components/title-field");
    const normalEdit = await renderInRouter(() => createElement(TitleField, { required: false }));
    expect(normalEdit).toContain(`placeholder="${messageMarkup(m.field_title())}"`);
    const questionEdit = await renderInRouter(() => createElement(TitleField, { required: true }));
    expect(questionEdit).toContain(`aria-label="${messageMarkup(m.field_title_required())}"`);
    expect(questionEdit).toContain(`placeholder="${messageMarkup(m.field_title_placeholder_question())}"`);
  });

  it("uses a dedicated POST form without a home carryover or AI declaration field", async () => {
    const { default: TopicNew, loader } = await editor();
    const base = await loader(h.args(h.request("/t/new", { as: "hana" })));
    const html = await renderInRouter(() => createElement(TopicNew as never, { loaderData: base, actionData: undefined, params: {}, matches: [] } as never), "/t/new");
    expect(html).toContain('action="/t/new"');
    expect(html).toContain('method="post"');
    expect(html).toMatch(/<textarea[^>]*required=""/);
    expect(html).not.toMatch(/value="expand"|value="collapse"|name="(?:aiAssistance|ai_assistance)"/);
  });

  it("refuses a POST from another site with 403, before it reads anything, and a visitor is sent to the login", async () => {
    const before = await topicCount();
    const out = await post("hana", { body: "他のサイトから" }, { origin: "https://evil.example" });
    expect(out.status).toBe(403);
    expect(await topicCount()).toBe(before);
    const { action } = await editor();
    expect(await h.outcome(async () => action(await h.signedArgs(h.request("/t/new", { form: { body: "x" } }))))).toMatchObject({ status: 302, location: "/login" });
  });

  it("has no composer for a member who is suspended: the screen leaves it out and a POST goes to /suspended", async () => {
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.sus));
    const { loader, default: Home } = await home();
    const data = (await loader(await h.signedArgs(h.request("/", { as: "sus" })))) as unknown as Record<string, unknown>;
    expect(data).not.toHaveProperty("composer");
    const html = await renderInRouter(() => createElement(Home as never, { loaderData: { ...data, aiOpen: { mdUrl: "http://x/home.md", mdPath: "/home.md" }, stanceMessage: null }, actionData: undefined, params: {}, matches: [] } as never));
    expect(html).not.toContain('name="body"');
    const before = await topicCount();
    expect(await post("sus", { body: "停止中の投稿" })).toMatchObject({ status: 302, location: "/suspended" });
    expect(await topicCount()).toBe(before);
    // a suspended member still reads the home
    expect((data as unknown as { topics: unknown[] }).topics.length).toBeGreaterThan(0);
  });
});

describe("the limits of posting from the screens", () => {
  it("are 20 topics and 60 replies an hour per member (a draft is not counted; reading and one-tap controls are not posting)", () => {
    expect(MEMBER_RATE_LIMITS.topic).toEqual({ limit: 20, windowSeconds: 3600 });
    expect(MEMBER_RATE_LIMITS.reply).toEqual({ limit: 60, windowSeconds: 3600 });
  });

  it("refuses the 21st topic in an hour with 429 and the words, keeps what was typed, creates nothing, and leaves other members alone", async () => {
    for (let i = 0; i < 20; i++) expect((await post("fast", { body: `連投 ${i}` })).status, String(i)).toBe(302);
    const before = await topicCount();
    const refused = await post("fast", { body: "21番目の投稿", title: "題" });
    expect(refused.status).toBe(429);
    expect(errorOf(refused)).toEqual({ error: "rate_limited", values: { body: "21番目の投稿", title: "題", asksStance: false, lang: "", intro: false } });
    expect(await topicCount()).toBe(before);
    expect(((refused.value as { init?: { headers?: Record<string, string> } }).init?.headers ?? {})["Retry-After"]).toBeDefined();
    expect((await post("kim", { body: "別の会員は投稿できる" })).status).toBe(302);
  });

  it("counts /t/new and the publishing of a draft in the same count, and a draft that is only saved or edited not at all; replies have their own count", async () => {
    const newTopic = await import("~/routes/topic-new");
    const draftRoute = await import("~/routes/draft");
    const topicRoute = await import("~/routes/topic");
    const send = (mod: { action: (a: never) => unknown }, path: string, form: Record<string, string>, params: Record<string, string> = {}) =>
      h.outcome(async () => mod.action(await h.signedArgs(h.request(path, { as: "slow", form: path.startsWith("/drafts/") ? await draftScreenForm(h.db, h.ids.slow, Number(params.id), form) : form }), params)));
    // 18 posts from the dedicated editor, then one from /t/new: 19 counted
    for (let i = 0; i < 18; i++) expect((await post("slow", { body: `数え ${i}` })).status).toBe(302);
    expect((await send(newTopic, "/t/new", { title: "新しい話題の画面", body: "本文" })).status).toBe(302);
    // saving drafts is not posting
    for (let i = 0; i < 5; i++) expect((await send(newTopic, "/t/new", { title: `下書き ${i}`, body: "b", intent: "draft" })).status).toBe(302);
    // the 20th: publishing a draft (it counts); then the 21st, from either publication route, is refused
    const draft = await createDraft(h.db, h.ids.slow, { kind: "topic", lang: "ja", title: "公開する下書き", body: "b" });
    if (!draft.ok) throw new Error("draft failed");
    expect((await send(draftRoute, `/drafts/${draft.id}`, { intent: "publish", title: "公開する下書き", body: "b", lang: "ja" }, { id: String(draft.id) })).status).toBe(302);
    expect((await post("slow", { body: "21番目（ホーム）" })).status).toBe(429);
    const viaNew = await send(newTopic, "/t/new", { title: "21番目（/t/new）", body: "本文" });
    expect(viaNew.status).toBe(429);
    expect(errorOf(viaNew as never)).toMatchObject({ error: "rate_limited", values: { title: "21番目（/t/new）", body: "本文" } });
    const second = await createDraft(h.db, h.ids.slow, { kind: "topic", lang: "ja", title: "二つ目の下書き", body: "b" });
    if (!second.ok) throw new Error("draft failed");
    const refusedDraft = await send(draftRoute, `/drafts/${second.id}`, { intent: "publish", title: "二つ目の下書き", body: "b", lang: "ja" }, { id: String(second.id) });
    expect(refusedDraft.status).toBe(429);
    expect((refusedDraft.value as { data: { error: string; saved: boolean } }).data).toMatchObject({ error: "rate_limited", saved: false });
    // saving it still works (and the draft is still there)
    expect((await send(draftRoute, `/drafts/${second.id}`, { intent: "save", title: "二つ目の下書き", body: "b2", lang: "ja" }, { id: String(second.id) })).status).toBe(200);
    // replies are a different count: the member can still reply
    const parent = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "返信の対象", body: "本文" });
    if (!parent.ok) throw new Error("topic failed");
    const reply = (n: number) => send(topicRoute, `/t/${parent.id}`, { body: `返信 ${n}`, lang: "ja" }, { id: String(parent.id) });
    expect((await reply(0)).status).toBe(302);
    for (let i = 0; i < 58; i++) await hitMemberLimit(h.db, "reply", h.ids.slow);
    expect((await reply(1)).status).toBe(302);
    const tooMany = await reply(2);
    expect(tooMany.status).toBe(429);
    expect((tooMany.value as { data: { error: string } }).data).toMatchObject({ intent: "reply", error: "rate_limited" });
  });

  it("counts the publishing of a draft of a reply as a reply, not as a topic", async () => {
    const parent = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "返信の下書き先", body: "本文" });
    if (!parent.ok) throw new Error("topic failed");
    const draftRoute = await import("~/routes/draft");
    const make = async () => {
      const d = await createDraft(h.db, h.ids.drafty, { kind: "reply", threadId: parent.id, lang: "ja", body: "返信の下書き" });
      if (!d.ok) throw new Error("draft failed");
      return d.id;
    };
    for (let i = 0; i < 59; i++) await hitMemberLimit(h.db, "reply", h.ids.drafty);
    const publish = async (id: number) => h.outcome(async () => draftRoute.action(await h.signedArgs(h.request(`/drafts/${id}`, { as: "drafty", form: { intent: "publish", body: "返信の下書き", lang: "ja", version: "1" } }), { id: String(id) })));
    expect((await publish(await make())).status).toBe(302);
    expect((await publish(await make())).status).toBe(429);
    // the topic count of this member is untouched
    expect((await hitMemberLimit(h.db, "topic", h.ids.drafty)).count).toBe(1);
  });
});
