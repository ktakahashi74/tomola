import { createElement } from "react";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drafts, entries } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { applyPastedFrontmatter, readEntryForm } from "~/lib/entry-form.server";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

const form = (over: Partial<ReturnType<typeof readEntryForm>> = {}) => ({ title: "", body: "", lang: "", asksStance: false, altOf: null, stanceTag: null, ...over });
// Input without any question attributes, used to construct expectations.
const noAttrs = { asksStance: false, altOf: null, stanceTag: null };
const md = (frontmatter: string, body = "Body.") => `---\n${frontmatter}\n---\n${body}`;
const opts = { defaultLang: "ja", threadId: 7 };

describe("applyPastedFrontmatter", () => {
  it("takes the title, language and ai_assistance from the frontmatter when the form leaves them empty (automatic), and strips it from the body", async () => {
    const res = (await applyPastedFrontmatter(form({ body: md("title: Pasted title\nlang: en\nai_assistance: draft", "First.\n\nSecond.") }), "topic", opts));
    expect(res).toEqual({ ok: true, language: { source: "explicit", detected: null }, parentId: undefined, input: { title: "Pasted title", body: "First.\n\nSecond.", lang: "en", langCode: null, langSource: "explicit", aiAssistance: "draft", ...noAttrs } });
  });

  it("hands over an empty title as it is when neither the form nor the frontmatter has one (a topic without a title is allowed; the service decides)", async () => {
    expect((await applyPastedFrontmatter(form({ body: md("lang: en", "Short remark.") }), "topic", opts))).toEqual({ ok: true, language: { source: "explicit", detected: null }, parentId: undefined, input: { title: "", body: "Short remark.", lang: "en", langCode: null, langSource: "explicit", aiAssistance: null, ...noAttrs } });
    // A pasted title, empty or null, is the same as none.
    expect((await applyPastedFrontmatter(form({ body: md("title: null\nlang: en", "Short remark.") }), "topic", opts))).toMatchObject({ ok: true, input: { title: "" } });
    expect((await applyPastedFrontmatter(form({ body: md("title: ''\nlang: en", "Short remark.") }), "topic", opts))).toMatchObject({ ok: true, input: { title: "" } });
  });

  it("lets what the user filled in win: a typed title and a chosen language; ai_assistance has no form field, so only the frontmatter carries it", async () => {
    const res = (await applyPastedFrontmatter(form({ title: "My title", lang: "fr", body: md("title: Pasted\nlang: en\nai_assistance: coauthor") }), "topic", opts));
    expect(res).toMatchObject({ ok: true, input: { title: "My title", lang: "fr", aiAssistance: "coauthor", body: "Body." } });
    // Only some are chosen: the language is the form's, ai_assistance is the frontmatter's.
    expect((await applyPastedFrontmatter(form({ lang: "de", body: md("lang: en\nai_assistance: polish") }), "topic", opts))).toMatchObject({ input: { lang: "de", aiAssistance: "polish" } });
    // An explicit none is a value: it differs from not stating one.
    expect((await applyPastedFrontmatter(form({ body: md("ai_assistance: none") }), "topic", opts))).toMatchObject({ input: { aiAssistance: "none" } });
  });

  it("falls back to the default language, and states no ai_assistance (null, not none), when neither the form nor the frontmatter says", async () => {
    expect((await applyPastedFrontmatter(form({ body: md("title: T") }), "topic", opts))).toMatchObject({ input: { lang: "ja", aiAssistance: null } });
    expect((await applyPastedFrontmatter(form({ body: "no frontmatter" }), "topic", opts))).toEqual({ ok: true, language: { source: "default", detected: null }, input: { title: "", body: "no frontmatter", lang: "ja", langCode: null, langSource: "default", aiAssistance: null, ...noAttrs } });
  });

  it("keeps text that does not parse as a YAML mapping as the body, unchanged", async () => {
    for (const body of ["---\nnot closed\nbody", "---\n- a\n- b\n---\nbody", "---\njust text\n---\nbody", "---\na: [\n---\nbody", "---\na: 1\na: 2\n---\nbody"]) {
      expect((await applyPastedFrontmatter(form({ body }), "topic", opts)), body).toMatchObject({ ok: true, input: { body } });
    }
    // Keep --- in a body that was not pasted from an export.
    expect((await applyPastedFrontmatter(form({ body: "intro\n---\ntitle: x\n---\nmore" }), "topic", opts))).toMatchObject({ input: { body: "intro\n---\ntitle: x\n---\nmore" } });
  });

  it("keeps a mapping with none of the post's keys as plain body text: a question-and-answer heading is not frontmatter", async () => {
    for (const body of ["---\nQ: x\nA: y\n---\n続き", "---\nNote: x\n---", "---\n---\nbody", "---\nname: x\ndate: 2026-10-01\n---\ntext", "---\nTitle: 大文字のキーは別のキー\n---\ntext"]) {
      for (const kind of ["topic", "reply"] as const) {
        expect((await applyPastedFrontmatter(form({ body }), kind, opts)), `${kind}: ${body}`).toMatchObject({ ok: true, input: { title: "", body, lang: "ja", aiAssistance: null, ...noAttrs } });
      }
    }
    // One post key is enough to identify front matter, even when other keys are present.
    expect((await applyPastedFrontmatter(form({ body: md("Q: x\ntitle: T", "rest") }), "topic", opts))).toMatchObject({ ok: true, input: { title: "T", body: "rest" } });
    for (const key of ["type: post", "title: T", "lang: en", "reply_to: null", "ai_assistance: none", "id: p-1", "thread: p-1", "content_trust: untrusted_user_content"]) {
      // type: post is topic front matter, so use the topic form.
      const res = (await applyPastedFrontmatter(form({ body: md(key, "rest") }), key === "type: post" ? "topic" : "reply", opts));
      expect(res, key).toMatchObject({ ok: true, input: { body: "rest" } });
    }
  });

  it("reports a frontmatter with unusable values (lang, ai_assistance, title, type, reply_to)", async () => {
    for (const fm of ["lang: xx", "ai_assistance: all", "title: {a: 1}", "type: note", "reply_to: nope"]) {
      expect((await applyPastedFrontmatter(form({ body: md(fm) }), "topic", opts)), fm).toEqual({ ok: false, error: "frontmatter_invalid" });
    }
  });

  it("refuses a frontmatter of the other kind: a reply's frontmatter in the topic form, a topic's in the reply form", async () => {
    expect((await applyPastedFrontmatter(form({ body: md("type: comment\nreply_to: c-1") }), "topic", opts))).toEqual({ ok: false, error: "frontmatter_type_mismatch" });
    expect((await applyPastedFrontmatter(form({ body: md("reply_to: p-7") }), "topic", opts))).toEqual({ ok: false, error: "frontmatter_type_mismatch" });
    expect((await applyPastedFrontmatter(form({ body: md("type: post\ntitle: T") }), "reply", opts))).toEqual({ ok: false, error: "frontmatter_type_mismatch" });
    // Front matter without a type works in either form.
    expect((await applyPastedFrontmatter(form({ body: md("lang: en") }), "reply", opts))).toMatchObject({ ok: true, input: { lang: "en" } });
    // In a reply form, type reply (comment) without reply_to replies to the topic. In a topic form, it is a type mismatch.
    expect((await applyPastedFrontmatter(form({ body: md("type: comment\nlang: en") }), "reply", opts))).toMatchObject({ ok: true, language: { source: "explicit", detected: null }, parentId: undefined, input: { lang: "en" } });
    expect((await applyPastedFrontmatter(form({ body: md("type: comment\nlang: en") }), "topic", opts))).toEqual({ ok: false, error: "frontmatter_type_mismatch" });
  });

  it("takes the reply target from the frontmatter in the reply form: a reply (c-id) becomes the parent, this topic (p-id) has none, another topic is refused", async () => {
    expect((await applyPastedFrontmatter(form({ body: md("reply_to: c-12") }), "reply", opts))).toMatchObject({ ok: true, parentId: 12 });
    expect((await applyPastedFrontmatter(form({ body: md("type: comment\nreply_to: p-7") }), "reply", opts))).toMatchObject({ ok: true, parentId: undefined });
    expect((await applyPastedFrontmatter(form({ body: md("reply_to: p-8") }), "reply", opts))).toEqual({ ok: false, error: "frontmatter_invalid" });
  });
});

describe("the new topic and reply forms with pasted frontmatter", () => {
  let h: RouteHarness;
  let topicId: number;
  let replyId: number;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
    await h.signIn("somchai", { homeArea: "th", readLangs: ["th"] });
    const t = await createTopic(h.db, h.ids.somchai, { lang: "th", title: "หัวข้อ", body: "เนื้อหา" });
    if (!t.ok) throw new Error("topic failed");
    topicId = t.id;
    const r = await createReply(h.db, h.ids.somchai, topicId, { lang: "th", body: "ตอบ" });
    if (!r.ok) throw new Error("reply failed");
    replyId = r.id;
  });
  afterAll(() => h.restore());

  const newTopic = async (fields: Record<string, string>) =>
    h.outcome(async () => (await import("~/routes/topic-new")).action(await h.signedArgs(h.request("/t/new", { as: "hana", form: fields }))));
  const reply = async (fields: Record<string, string>) =>
    h.outcome(async () => (await import("~/routes/topic")).action(await h.signedArgs(h.request(`/t/${topicId}`, { as: "hana", form: fields }), { id: String(topicId) })));

  it("posts a topic whose title, language and AI declaration come from the pasted frontmatter", async () => {
    const res = await newTopic({ title: "", body: md("title: From frontmatter\nlang: en\nai_assistance: coauthor", "Hello there."), lang: "" });
    expect(res.status).toBe(302);
    const [row] = await h.db.select().from(entries).where(eq(entries.title, "From frontmatter"));
    expect(row).toMatchObject({ kind: "topic", lang: "en", aiAssistance: "coauthor", body: "Hello there.", via: "web", authorId: h.ids.hana });
    expect(res.location).toBe(`/t/${row.id}?posted=${row.id}`);
  });

  it("posts a topic without a title from the new topic form (the title field is optional), and keeps what was written when a question lacks its title", async () => {
    const res = await newTopic({ title: "", body: "A short remark, no title.", lang: "ja" });
    expect(res.status).toBe(302);
    const [row] = await h.db.select().from(entries).where(eq(entries.body, "A short remark, no title."));
    expect(row).toMatchObject({ kind: "topic", title: null, lang: "ja" });
    expect(res.location).toBe(`/t/${row.id}?posted=${row.id}`);
    // "Ask for stances" without a title: refused with invalid_title, and what was written is handed back (kept even without JavaScript): the title and the body, and also
    // "ask for stances" and the language, which cannot be changed after posting.
    const refused = await newTopic({ title: "", asksStance: "1", body: "Kept body.", lang: "en" });
    expect(refused.status).toBe(400);
    expect((refused.value as { data: unknown }).data).toEqual({ error: "invalid_title", values: { aiMaterial: "", title: "", body: "Kept body.", asksStance: true, lang: "en", intro: false } });
    expect(await h.db.select().from(entries).where(eq(entries.body, "Kept body."))).toEqual([]);
    // The language left on "automatic" is handed back as it is (empty), and an unchecked box as false.
    const auto = await newTopic({ title: "t".repeat(201), body: "Kept auto.", lang: "" });
    expect((auto.value as { data: unknown }).data).toEqual({ error: "invalid_title", values: { aiMaterial: "", title: "t".repeat(201), body: "Kept auto.", asksStance: false, lang: "", intro: false } });
    // A draft is saved without a title either way, and the title is stored as NULL, never as an empty or blank string.
    const draft = await newTopic({ intent: "draft", title: "", asksStance: "1", body: "Draft of a question.", lang: "ja" });
    expect(draft.status).toBe(302);
    for (const [title, body] of [["", "Draft with an empty title."], ["   ", "Draft with a blank title."]]) {
      expect((await newTopic({ intent: "draft", title, body, lang: "ja" })).status).toBe(302);
      const [saved] = await h.db.select().from(drafts).where(eq(drafts.body, body));
      expect(saved.title).toBeNull();
    }
  });

  it("uses the explicit form values over the frontmatter, and the profile's first writing language when nothing says; a post written on screen states no ai_assistance", async () => {
    await newTopic({ title: "Typed title", body: md("title: Pasted\nlang: en", "Body A."), lang: "fr" });
    const [a] = await h.db.select().from(entries).where(eq(entries.title, "Typed title"));
    expect(a).toMatchObject({ lang: "fr", aiAssistance: null, body: "Body A." });
    await newTopic({ title: "Plain", body: "No frontmatter here.", lang: "" });
    const [b] = await h.db.select().from(entries).where(eq(entries.title, "Plain"));
    expect(b).toMatchObject({ lang: "ja", body: "No frontmatter here." });
  });

  it("keeps unparseable frontmatter as the body and posts it as it is", async () => {
    const body = "---\n- just\n- a list\n---\nAfter it.";
    await newTopic({ title: "List frontmatter", body, lang: "ja" });
    const [row] = await h.db.select().from(entries).where(eq(entries.title, "List frontmatter"));
    expect(row.body).toBe(body);
  });

  it("answers a problem with the pasted frontmatter with 400 and posts nothing", async () => {
    const before = (await h.db.select().from(entries)).length;
    const bad = await newTopic({ title: "", body: md("title: T\nlang: xx"), lang: "" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify((bad.value as { data: unknown }).data)).toContain("frontmatter_invalid");
    const mismatch = await newTopic({ title: "T", body: md("type: comment\nreply_to: c-1"), lang: "ja" });
    expect(JSON.stringify((mismatch.value as { data: unknown }).data)).toContain("frontmatter_type_mismatch");
    // Without a title in the frontmatter and with the title of the form empty, the title is optional (it becomes a topic without a title); only a topic that asks for stances (asks_stance: true) gets the title error
    const noTitle = await newTopic({ title: "", body: md("lang: en\nasks_stance: true"), lang: "" });
    expect(noTitle.status).toBe(400);
    expect(JSON.stringify((noTitle.value as { data: unknown }).data)).toContain("invalid_title");
    expect((await h.db.select().from(entries)).length).toBe(before);
  });

  it("saves a draft from the pasted frontmatter too", async () => {
    const res = await newTopic({ intent: "draft", title: "", body: md("title: Draft title\nlang: en", "Draft body."), lang: "" });
    expect(res.status).toBe(302);
    const [d] = await h.db.select().from(drafts).where(eq(drafts.title, "Draft title"));
    expect(d).toMatchObject({ kind: "topic", lang: "en", body: "Draft body.", via: "web" });
  });

  it("posts a reply to a reply given by reply_to, with the language from the frontmatter", async () => {
    const res = await reply({ body: md(`type: comment\nreply_to: c-${replyId}\nlang: en\nai_assistance: draft`, "I agree."), lang: "" });
    expect(res.status).toBe(302);
    const [row] = await h.db.select().from(entries).where(eq(entries.body, "I agree."));
    expect(row).toMatchObject({ kind: "reply", threadId: topicId, parentId: replyId, lang: "en", aiAssistance: "draft" });
    expect(res.location).toContain(`#c-${row.id}`);
    // A reply to the topic itself, a nonexistent reply, and another topic.
    await reply({ body: md(`reply_to: p-${topicId}`, "To the topic."), lang: "ja" });
    const [top] = await h.db.select().from(entries).where(eq(entries.body, "To the topic."));
    expect(top.parentId).toBeNull();
    const missing = await reply({ body: md("reply_to: c-999999", "Nowhere."), lang: "ja" });
    expect(missing.status).toBe(400);
    expect(JSON.stringify((missing.value as { data: unknown }).data)).toContain("parent_not_in_thread");
    const other = await reply({ body: md("reply_to: p-999999", "Other topic."), lang: "ja" });
    expect(JSON.stringify((other.value as { data: unknown }).data)).toContain("frontmatter_invalid");
    expect(await h.db.select().from(entries).where(eq(entries.body, "Nowhere."))).toHaveLength(0);
  });

  it("stores a body that starts with an unrelated YAML mapping in full, in the topic form, the reply form and as drafts", async () => {
    const qa = "---\nQ: 質問\nA: 答え\n---\n続き";
    const note = "---\nNote: x\n---";
    await newTopic({ title: "Q and A", body: qa, lang: "ja" });
    const [t] = await h.db.select().from(entries).where(eq(entries.title, "Q and A"));
    expect(t.body).toBe(qa);
    await newTopic({ title: "Note only", body: note, lang: "" });
    expect((await h.db.select().from(entries).where(eq(entries.title, "Note only")))[0]).toMatchObject({ body: note, lang: "ja" });
    const r1 = await reply({ body: qa, lang: "ja" });
    expect(r1.status).toBe(302);
    expect((await h.db.select().from(entries).where(eq(entries.body, qa))).filter((e) => e.kind === "reply")).toHaveLength(1);
    await reply({ body: note, lang: "" });
    expect((await h.db.select().from(entries).where(eq(entries.body, note))).filter((e) => e.kind === "reply")).toHaveLength(1);
    await newTopic({ intent: "draft", title: "", body: qa, lang: "ja" });
    expect((await h.db.select().from(drafts).where(eq(drafts.body, qa)))).toHaveLength(1);
  });

  it("strips the pasted frontmatter from the preview only for the forms that strip it on submit, and decides exactly as submit does", async () => {
    const { action } = await import("~/routes/preview");
    const preview = async (body: string, flag?: string) => {
      const res = (await action(await h.signedArgs(h.request("/preview", { as: "hana", form: { body, ...(flag ? { frontmatter: flag } : {}) } })))) as Response;
      return { status: res.status, text: await res.text() };
    };
    const shown = await preview(md("title: T\nlang: en", "Only **this** shows."), "topic");
    expect(shown.text).toContain("<strong>this</strong>");
    expect(shown.text).not.toContain("title");
    // Unparseable front matter renders unchanged as body text.
    expect((await preview("---\n- a\n---\nbody", "topic")).text).toContain("body");
    // A map without post keys remains body text, as on submit, rendering as a horizontal rule and a "Q: 質問" paragraph.
    const qa = await preview("---\nQ: 質問\nA: 答え\n---\n続き", "reply");
    expect(qa.status).toBe(200);
    expect(qa.text).toContain("<hr>");
    expect(qa.text).toContain("Q: 質問");
    expect(qa.text).toContain("続き");
    // Front matter with post keys but invalid values also fails in preview; submit returns frontmatter_invalid.
    const invalid = await preview(md("title: T\nlang: xx"), "topic");
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.text)).toEqual({ error: "frontmatter_invalid" });
    // Type mismatches behave the same as on submit.
    const mismatch = await preview(md("type: comment\nreply_to: c-1"), "topic");
    expect(JSON.parse(mismatch.text)).toEqual({ error: "frontmatter_type_mismatch" });
    expect((await preview(md("type: post\ntitle: T"), "reply")).status).toBe(400);
    // Edit and draft forms without the flag save the body unchanged, so they render the leading --- as a horizontal rule and heading.
    const plain = await preview(md("title: T", "Kept text."));
    expect(plain.text).toContain("<hr>");
    expect(plain.text).toContain("title: T");
    expect(plain.text).toContain("Kept text.");
  });
});

describe("the new topic form drawn again after a refusal (no JavaScript)", () => {
  // The form uses <Form>, so it is drawn inside a static router.
  async function render(actionData: unknown, loaderData: Record<string, unknown> = {}): Promise<string> {
    const { default: TopicNew } = await import("~/routes/topic-new");
    const props = { loaderData: { aiMaterialLabels: { add: "ai_material_add", title: "ai_material_title", help: "ai_material_input_help", error: "ai_material_error" }, defaultLang: "ja", prefill: null, asksStance: false, alt: null, altNotFound: false, draftIds: [], ...loaderData }, actionData, params: {}, matches: [] };
    return renderInRouter(() => createElement(TopicNew as never, props as never), "/t/new");
  }
  // The tag of the input with this name (the attributes are in no fixed order).
  const inputTag = (html: string, name: string) => html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`))?.[0] ?? "";
  // A checked asksStance input submits "1"; an unchecked input submits no value.
  const checkedKind = (html: string) => (html.match(/<input\b[^>]*\bname="asksStance"[^>]*>/g) ?? []).find(tag => tag.includes('checked=""')) ?? "";
  const refused = { error: "invalid_title", values: { aiMaterial: "", title: "", body: "Kept body.", asksStance: true, lang: "en" } };

  it("keeps the checked box, the chosen language, the title and the body; the form has no AI level to keep", async () => {
    const html = await render(refused);
    expect(checkedKind(html)).toContain('value="1"');
    expect(html).toMatch(/<input[^>]*name="lang"[^>]*value="en"/);
    // The values handed back carry no ai_assistance, and the form has no such field.
    expect(Object.keys(refused.values).sort()).toEqual(["aiMaterial", "asksStance", "body", "lang", "title"]);
    expect(html).not.toContain("aiAssistance");
    expect(html).not.toMatch(/<input[^>]*name="lang"[^>]*value=""/);
    expect(html).toContain(">Kept body.</textarea>");
    // A question needs its title: the field is required again.
    expect(inputTag(html, "title")).toContain('required=""');
    const typed = await render({ error: "invalid_title", values: { ...refused.values, title: "Too long".repeat(30), asksStance: false } });
    expect(inputTag(typed, "title")).toContain(`value="${"Too long".repeat(30)}"`);
    expect(inputTag(typed, "title")).not.toContain("required");
    expect(checkedKind(typed)).not.toContain('value="1"');
  });

  it("starts from the defaults without a refusal: the box as the loader says, the language on automatic", async () => {
    for (const html of [await render(undefined), await render({ error: "frontmatter_invalid" })]) {
      expect(inputTag(html, "asksStance")).toContain('type="checkbox"');
      expect(checkedKind(html)).toBe("");
      expect(html).toMatch(/<input[^>]*name="lang"[^>]*value=""/);
    }
    expect(checkedKind(await render(undefined, { asksStance: true }))).toContain('value="1"');
  });
});
