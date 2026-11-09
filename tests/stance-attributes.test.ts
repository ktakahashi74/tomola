import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drafts, entries, rateLimits } from "~/lib/db/schema";
import { createDraft, publishDraft, updateDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { interpretFrontmatter } from "~/lib/entry-frontmatter.server";
import { hideEntry, type Actor } from "~/lib/moderation.server";
import { softDeleteEntry } from "~/lib/entries.server";
import { checkStanceAttributes, STANCE_TAGS, type StanceAttrInput } from "~/lib/stances";
import { createApiToken } from "~/lib/tokens.server";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// One function, checkStanceAttributes in app/lib/stances.ts, validates combinations of asks_stance, alt_of, and stance_tag across creation, draft, and edit paths.
// Check both the pure-function rule table and all callers: createTopic, createReply, editEntry, createDraft in UI/API, updateDraft, and publishDraft,
// ensuring the same invalid input is rejected with the same error category.

const live = { kind: "topic" as const, asksStance: true, deleted: false, hidden: false };
const base: StanceAttrInput = { kind: "topic", mode: "create", asksStance: false, altOf: null, stanceTag: null };
const check = (over: Partial<StanceAttrInput>) => checkStanceAttributes({ ...base, ...over });

describe("checkStanceAttributes: the rules, in order", () => {
  it("accepts the ordinary combinations", () => {
    expect(check({})).toBeNull();
    expect(check({ asksStance: true })).toBeNull();
    expect(check({ asksStance: true, altOf: 7, altTarget: live })).toBeNull();
    expect(check({ kind: "reply" })).toBeNull();
    for (const stanceTag of STANCE_TAGS) expect(check({ kind: "reply", stanceTag, threadAsksStance: true })).toBeNull();
    expect(check({ kind: "reply", mode: "edit", asksStance: false, altOf: null, stanceTag: "agree", threadAsksStance: true, current: { asksStance: false, altOf: null } })).toBeNull();
    expect(check({ mode: "edit", asksStance: true, altOf: 7, current: { asksStance: true, altOf: 7 } })).toBeNull();
  });

  it("1. a reply is neither a question nor another way of asking", () => {
    expect(check({ kind: "reply", asksStance: true })).toBe("invalid_asks_stance");
    expect(check({ kind: "reply", altOf: 7 })).toBe("invalid_alt_of");
    // asks_stance errors take precedence.
    expect(check({ kind: "reply", asksStance: true, altOf: 7 })).toBe("invalid_asks_stance");
  });

  it("2. a topic carries no reply mark", () => {
    for (const stanceTag of STANCE_TAGS) expect(check({ stanceTag })).toBe("invalid_stance_tag");
    expect(check({ asksStance: true, stanceTag: "agree" })).toBe("invalid_stance_tag");
  });

  it("3. an edit cannot add, remove or change asks_stance and alt_of", () => {
    expect(check({ mode: "edit", asksStance: true, current: { asksStance: false, altOf: null } })).toBe("invalid_asks_stance");
    expect(check({ mode: "edit", asksStance: false, current: { asksStance: true, altOf: null } })).toBe("invalid_asks_stance");
    expect(check({ mode: "edit", asksStance: true, altOf: 8, current: { asksStance: true, altOf: 7 } })).toBe("invalid_alt_of");
    expect(check({ mode: "edit", asksStance: true, altOf: null, current: { asksStance: true, altOf: 7 } })).toBe("invalid_alt_of");
    expect(check({ mode: "edit", asksStance: true, altOf: 7, current: { asksStance: true, altOf: null } })).toBe("invalid_alt_of");
    // If the current value is unknown, treat the question attribute as unset.
    expect(check({ mode: "edit", asksStance: true })).toBe("invalid_asks_stance");
  });

  it("4. another way of asking needs asks_stance", () => {
    expect(check({ altOf: 7, altTarget: live })).toBe("invalid_alt_of");
    expect(check({ mode: "draft", altOf: 7, altTarget: live })).toBe("invalid_alt_of");
  });

  it("5. on create and draft, the target must be a question that is neither deleted nor hidden", () => {
    for (const mode of ["create", "draft"] as const) {
      const input = { mode, asksStance: true, altOf: 7 };
      expect(check({ ...input, altTarget: null }), `${mode} missing`).toBe("invalid_alt_of");
      expect(check({ ...input }), `${mode} unknown`).toBe("invalid_alt_of");
      expect(check({ ...input, altTarget: { ...live, kind: "reply" } }), `${mode} reply`).toBe("invalid_alt_of");
      expect(check({ ...input, altTarget: { ...live, asksStance: false } }), `${mode} not a question`).toBe("invalid_alt_of");
      expect(check({ ...input, altTarget: { ...live, deleted: true } }), `${mode} deleted`).toBe("invalid_alt_of");
      expect(check({ ...input, altTarget: { ...live, hidden: true } }), `${mode} hidden`).toBe("invalid_alt_of");
      expect(check({ ...input, altTarget: live }), `${mode} ok`).toBeNull();
    }
    // Editing cannot change the target chosen at creation, so do not check the target's current state.
    expect(check({ mode: "edit", asksStance: true, altOf: 7, altTarget: { ...live, hidden: true }, current: { asksStance: true, altOf: 7 } })).toBeNull();
  });

  it("6. a reply mark needs a question as the topic", () => {
    expect(check({ kind: "reply", stanceTag: "agree" })).toBe("invalid_stance_tag");
    expect(check({ kind: "reply", stanceTag: "objection", threadAsksStance: false })).toBe("invalid_stance_tag");
    expect(check({ kind: "reply", stanceTag: "objection", threadAsksStance: true })).toBeNull();
    expect(check({ kind: "reply", mode: "draft", stanceTag: "neither", threadAsksStance: false })).toBe("invalid_stance_tag");
  });
});

describe("the check runs on every path that creates or changes a topic, a reply or a draft", () => {
  let h: RouteHarness;
  let hana: string;
  let plain: number;
  let plainReply: number;
  let question: number;
  let questionReply: number;
  let hiddenQuestion: number;
  let deletedQuestion: number;
  let draftToken: string;
  const moderator: Actor = { id: "", scope: { operator: true, langs: [] } };

  beforeAll(async () => {
    h = await setupRouteHarness();
    hana = await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
    const taro = await h.signIn("taro", { homeArea: "ja" });
    moderator.id = taro;
    const topic = async (title: string, asksStance = false) => {
      const res = await createTopic(h.db, hana, { lang: "ja", title, body: "本文。", asksStance });
      if (!res.ok) throw new Error(`topic failed: ${res.error}`);
      return res.id;
    };
    plain = await topic("ふつうの話題");
    question = await topic("問い", true);
    hiddenQuestion = await topic("非表示の問い", true);
    deletedQuestion = await topic("削除された問い", true);
    const reply = async (threadId: number) => {
      const res = await createReply(h.db, hana, threadId, { lang: "ja", body: "返信。" });
      if (!res.ok) throw new Error(`reply failed: ${res.error}`);
      return res.id;
    };
    plainReply = await reply(plain);
    questionReply = await reply(question);
    // Hidden and deleted entries, through moderation and author deletion. Create replies first because hidden topics cannot receive replies.
    expect((await hideEntry(h.db, moderator, { entryId: hiddenQuestion, reason: "spam", note: "n" })).ok).toBe(true);
    expect((await softDeleteEntry(h.db, deletedQuestion)).ok).toBe(true);
    const token = await createApiToken(h.db, hana, { name: "d", kind: "draft" });
    if (!token.ok) throw new Error("token failed");
    draftToken = token.token;
  });
  afterAll(() => h.restore());

  const L = { lang: "ja", body: "本文。" };
  // Every path rejects the same error with the same category. Record each path's error category or "ok".
  type Path = () => Promise<string>;
  const code = (res: { ok: true } | { ok: false; error: string }) => (res.ok ? "ok" : res.error);

  // Topic creation paths: UI posting via createTopic, UI drafts via createDraft, and API drafts via POST /api/drafts.
  const topicPaths = (input: { asksStance?: boolean; altOf?: number | null; stanceTag?: string | null }): Record<string, Path> => ({
    createTopic: async () => code(await createTopic(h.db, hana, { ...L, title: "題", ...input })),
    createDraft: async () => code(await createDraft(h.db, hana, { kind: "topic", ...L, title: "題", ...input })),
    api: async () => {
      const lines = ["type: topic", "title: 題", "lang: ja"];
      if (input.asksStance !== undefined) lines.push(`asks_stance: ${input.asksStance}`);
      if (input.altOf) lines.push(`alt_of: p-${input.altOf}`);
      if (input.stanceTag) lines.push(`stance_tag: ${input.stanceTag}`);
      return apiDraft(`---\n${lines.join("\n")}\n---\n本文。`);
    },
  });
  // Reply creation paths.
  const replyPaths = (threadId: number, input: { asksStance?: boolean; altOf?: number | null; stanceTag?: string | null }): Record<string, Path> => ({
    createReply: async () => code(await createReply(h.db, hana, threadId, { ...L, ...input })),
    createDraft: async () => code(await createDraft(h.db, hana, { kind: "reply", threadId, ...L, ...input })),
    api: async () => {
      const lines = [`reply_to: p-${threadId}`, "lang: ja"];
      if (input.asksStance !== undefined) lines.push(`asks_stance: ${input.asksStance}`);
      if (input.altOf) lines.push(`alt_of: p-${input.altOf}`);
      if (input.stanceTag) lines.push(`stance_tag: ${input.stanceTag}`);
      return apiDraft(`---\n${lines.join("\n")}\n---\n返信。`);
    },
  });

  async function apiDraft(text: string): Promise<string> {
    await h.db.delete(rateLimits);
    const { action } = await import("~/routes/api.drafts");
    const res = (await action({
      request: new Request(`${BASE}/api/drafts`, { method: "POST", headers: { authorization: `Bearer ${draftToken}`, "content-type": "text/markdown" }, body: text }),
      params: {},
      context: {},
    } as never)) as Response;
    const json = (await res.json()) as { error?: string };
    if (res.status === 201) return "ok";
    expect(res.status).toBe(400);
    return json.error ?? `status ${res.status}`;
  }

  async function expectAll(paths: Record<string, Path>, expected: string) {
    for (const [name, run] of Object.entries(paths)) expect(await run(), name).toBe(expected);
  }

  it("a topic: asking for stances and pointing at a live question are accepted everywhere", async () => {
    await expectAll(topicPaths({ asksStance: true }), "ok");
    await expectAll(topicPaths({ asksStance: true, altOf: question }), "ok");
    await expectAll(topicPaths({}), "ok");
  });

  it("a topic that points at another question without asking for stances is invalid_alt_of", async () => {
    await expectAll(topicPaths({ altOf: question }), "invalid_alt_of");
    await expectAll(topicPaths({ asksStance: false, altOf: question }), "invalid_alt_of");
  });

  it("a topic cannot point at an ordinary topic, a reply, nothing, a deleted question or a hidden question", async () => {
    for (const altOf of [plain, plainReply, 424242, deletedQuestion, hiddenQuestion]) {
      await expectAll(topicPaths({ asksStance: true, altOf }), "invalid_alt_of");
    }
  });

  it("a topic cannot carry a reply mark", async () => {
    await expectAll(topicPaths({ stanceTag: "agree" }), "invalid_stance_tag");
    await expectAll(topicPaths({ asksStance: true, stanceTag: "objection" }), "invalid_stance_tag");
  });

  it("a reply: a mark is accepted on a reply to a question only, and a reply is not a question or another way of asking", async () => {
    for (const stanceTag of STANCE_TAGS) await expectAll(replyPaths(question, { stanceTag }), "ok");
    await expectAll(replyPaths(question, {}), "ok");
    await expectAll(replyPaths(plain, {}), "ok");
    await expectAll(replyPaths(plain, { stanceTag: "agree" }), "invalid_stance_tag");
    await expectAll(replyPaths(plain, { stanceTag: "objection" }), "invalid_stance_tag");
    await expectAll(replyPaths(question, { asksStance: true }), "invalid_asks_stance");
    await expectAll(replyPaths(question, { altOf: question }), "invalid_alt_of");
  });

  it("a mark outside the four values is invalid_stance_tag, a non-boolean asks_stance is invalid_asks_stance, a malformed alt_of is invalid_alt_of", async () => {
    expect(await createReply(h.db, hana, question, { ...L, stanceTag: "maybe" })).toEqual({ ok: false, error: "invalid_stance_tag" });
    expect(await createDraft(h.db, hana, { kind: "reply", threadId: question, ...L, stanceTag: "maybe" })).toEqual({ ok: false, error: "invalid_stance_tag" });
    expect(await createTopic(h.db, hana, { ...L, title: "題", asksStance: "yes" })).toEqual({ ok: false, error: "invalid_asks_stance" });
    expect(await createTopic(h.db, hana, { ...L, title: "題", asksStance: true, altOf: "p-1" })).toEqual({ ok: false, error: "invalid_alt_of" });
    expect(await createTopic(h.db, hana, { ...L, title: "題", asksStance: true, altOf: Number.NaN })).toEqual({ ok: false, error: "invalid_alt_of" });
    expect(await createTopic(h.db, hana, { ...L, title: "題", asksStance: true, altOf: 0 })).toEqual({ ok: false, error: "invalid_alt_of" });
  });

  it("the frontmatter reader names the same errors, and the API answers 400 with them before anything is stored", async () => {
    const read = (data: Record<string, unknown>) => {
      const res = interpretFrontmatter(data);
      return res.ok ? "ok" : res.error;
    };
    expect(read({ asks_stance: true })).toBe("ok");
    expect(read({ asks_stance: "true" })).toBe("invalid_asks_stance");
    expect(read({ asks_stance: 1 })).toBe("invalid_asks_stance");
    expect(read({ asks_stance: true, alt_of: "p-12" })).toBe("ok");
    for (const alt_of of ["c-12", "12", "p-0", "p-12x", 12, true, ["p-1"]]) expect(read({ asks_stance: true, alt_of }), String(alt_of)).toBe("invalid_alt_of");
    expect(read({ reply_to: "p-1", stance_tag: "objection" })).toBe("ok");
    expect(read({ reply_to: "p-1", stance_tag: "maybe" })).toBe("invalid_stance_tag");
    expect(read({ reply_to: "p-1", stance_tag: 1 })).toBe("invalid_stance_tag");
    // Kind mismatches: asks_stance: true or alt_of on a reply, and stance_tag on a topic.
    expect(read({ reply_to: "p-1", asks_stance: true })).toBe("invalid_asks_stance");
    expect(read({ reply_to: "p-1", alt_of: "p-2" })).toBe("invalid_alt_of");
    expect(read({ type: "topic", stance_tag: "agree" })).toBe("invalid_stance_tag");
    expect(read({ stance_tag: "agree" })).toBe("invalid_stance_tag");
    // null is equivalent to absence when pasting Markdown front matter unchanged. asks_stance: false on a reply is harmless too.
    expect(read({ reply_to: "p-1", asks_stance: null, alt_of: null, stance_tag: null })).toBe("ok");
    expect(read({ reply_to: "p-1", asks_stance: false })).toBe("ok");
    const before = await h.db.select().from(drafts);
    expect(await apiDraft("---\nasks_stance: \"true\"\ntitle: t\n---\nb")).toBe("invalid_asks_stance");
    expect(await apiDraft("---\nasks_stance: true\nalt_of: c-1\ntitle: t\n---\nb")).toBe("invalid_alt_of");
    expect(await apiDraft(`---\nreply_to: p-${question}\nstance_tag: maybe\n---\nb`)).toBe("invalid_stance_tag");
    expect(await apiDraft(`---\nreply_to: p-${question}\nasks_stance: true\n---\nb`)).toBe("invalid_asks_stance");
    expect((await h.db.select().from(drafts)).length).toBe(before.length);
  });

  it("editEntry: asks_stance and alt_of cannot be changed, a topic cannot get a mark, a mark on a reply is only for a question", async () => {
    const [q] = await h.db.select().from(entries).where(eq(entries.id, question));
    expect(q.asksStance).toBe(true);
    const edit = async (id: number, input: Record<string, unknown>, kind: "topic" | "reply") => {
      const res = await editEntry(h.db, hana, id, input, { kind });
      return res.ok ? "ok" : res.error;
    };
    const topicInput = { title: "問い", body: "本文。" };
    // It cannot be added or removed.
    expect(await edit(question, { ...topicInput, asksStance: false }, "topic")).toBe("invalid_asks_stance");
    expect(await edit(plain, { title: "ふつうの話題", body: "本文。", asksStance: true }, "topic")).toBe("invalid_asks_stance");
    // The target cannot be changed.
    expect(await edit(question, { ...topicInput, altOf: plain }, "topic")).toBe("invalid_alt_of");
    expect(await edit(plain, { title: "ふつうの話題", body: "本文。", altOf: question }, "topic")).toBe("invalid_alt_of");
    // Accept resubmission of the same value.
    expect(await edit(question, { ...topicInput, asksStance: true }, "topic")).toBe("ok");
    // Topics cannot have reply tags.
    expect(await edit(question, { ...topicInput, stanceTag: "agree" }, "topic")).toBe("invalid_stance_tag");
    expect(await edit(question, { ...topicInput, stanceTag: null }, "topic")).toBe("ok");
    // Replies can have tags only when replying to a question; they cannot themselves be questions or alternatives.
    expect(await edit(questionReply, { body: "返信。", stanceTag: "agree" }, "reply")).toBe("ok");
    expect(await edit(questionReply, { body: "返信。", stanceTag: "maybe" }, "reply")).toBe("invalid_stance_tag");
    expect(await edit(plainReply, { body: "返信。", stanceTag: "agree" }, "reply")).toBe("invalid_stance_tag");
    expect(await edit(plainReply, { body: "返信。", asksStance: true }, "reply")).toBe("invalid_asks_stance");
    expect(await edit(plainReply, { body: "返信。", altOf: question }, "reply")).toBe("invalid_alt_of");
    // Rejected inputs change nothing.
    const [again] = await h.db.select().from(entries).where(eq(entries.id, plainReply));
    expect(again.stanceTag).toBeNull();
    expect(again.asksStance).toBe(false);
  });

  it("updateDraft: asks_stance and the mark can change, the target cannot, and a draft cannot be saved as a question's former self", async () => {
    // A topic draft.
    const d = await createDraft(h.db, hana, { kind: "topic", ...L, title: "題", asksStance: true });
    if (!d.ok) throw new Error("draft failed");
    const save = async (id: number, input: Record<string, unknown>) => code(await updateDraft(h.db, hana, id, { lang: "ja", body: "本文。", title: "題", ...input }));
    expect(await save(d.id, { asksStance: false })).toBe("ok");
    expect((await h.db.select().from(drafts).where(eq(drafts.id, d.id)))[0].asksStance).toBe(false);
    expect(await save(d.id, { asksStance: true })).toBe("ok");
    // A topic draft cannot have a reply tag.
    expect(await save(d.id, { stanceTag: "agree" })).toBe("invalid_stance_tag");
    expect(await save(d.id, { asksStance: "yes" })).toBe("invalid_asks_stance");
    // An alternative draft cannot save with "立場を聞く" cleared because its target remains. Saving cannot change that target.
    const alt = await createDraft(h.db, hana, { kind: "topic", ...L, title: "題", asksStance: true, altOf: question });
    if (!alt.ok) throw new Error("draft failed");
    expect(await save(alt.id, { asksStance: false })).toBe("invalid_alt_of");
    expect(await save(alt.id, { altOf: plain })).toBe("ok");
    expect((await h.db.select().from(drafts).where(eq(drafts.id, alt.id)))[0]).toMatchObject({ asksStance: true, altOf: question });
    // A target becoming hidden afterward does not block draft saving; reject at publication.
    const late = await createDraft(h.db, hana, { kind: "topic", ...L, title: "題", asksStance: true, altOf: question });
    if (!late.ok) throw new Error("draft failed");
    // Reply drafts can have tags only when replying to a question.
    const onQuestion = await createDraft(h.db, hana, { kind: "reply", threadId: question, ...L });
    const onPlain = await createDraft(h.db, hana, { kind: "reply", threadId: plain, ...L });
    if (!onQuestion.ok || !onPlain.ok) throw new Error("draft failed");
    expect(await save(onQuestion.id, { stanceTag: "disagree" })).toBe("ok");
    expect((await h.db.select().from(drafts).where(eq(drafts.id, onQuestion.id)))[0].stanceTag).toBe("disagree");
    expect(await save(onQuestion.id, { stanceTag: null })).toBe("ok");
    expect((await h.db.select().from(drafts).where(eq(drafts.id, onQuestion.id)))[0].stanceTag).toBeNull();
    expect(await save(onPlain.id, { stanceTag: "disagree" })).toBe("invalid_stance_tag");
    expect(await save(onPlain.id, { asksStance: true })).toBe("invalid_asks_stance");
    // undefined leaves the value unchanged.
    expect(await save(onQuestion.id, { stanceTag: "neither" })).toBe("ok");
    expect(await save(onQuestion.id, {})).toBe("ok");
    expect((await h.db.select().from(drafts).where(eq(drafts.id, onQuestion.id)))[0].stanceTag).toBe("neither");
  });

  it("publishDraft: the draft's attributes go to the post, and the same check runs again at publication (the target may have been hidden or deleted since)", async () => {
    // Questions, alternatives, and tagged replies publish with their attributes intact.
    const q = await createDraft(h.db, hana, { kind: "topic", ...L, title: "下書きの問い", asksStance: true });
    const alt = await createDraft(h.db, hana, { kind: "topic", ...L, title: "下書きの別の立て方", asksStance: true, altOf: question });
    const r = await createDraft(h.db, hana, { kind: "reply", threadId: question, ...L, stanceTag: "objection" });
    if (!q.ok || !alt.ok || !r.ok) throw new Error("draft failed");
    const published = [await publishDraft(h.db, hana, q.id), await publishDraft(h.db, hana, alt.id), await publishDraft(h.db, hana, r.id)];
    for (const p of published) expect(p.ok).toBe(true);
    const rows = await Promise.all(published.map(async (p) => (p.ok ? (await h.db.select().from(entries).where(eq(entries.id, p.id)))[0] : null)));
    expect(rows[0]).toMatchObject({ kind: "topic", asksStance: true, altOf: null, stanceTag: null });
    expect(rows[1]).toMatchObject({ kind: "topic", asksStance: true, altOf: question, stanceTag: null });
    expect(rows[2]).toMatchObject({ kind: "reply", asksStance: false, altOf: null, stanceTag: "objection" });
    // If the target question becomes hidden after draft creation, reject publication and retain the draft.
    const target = await createTopic(h.db, hana, { ...L, title: "あとで非表示になる問い", asksStance: true });
    if (!target.ok) throw new Error("topic failed");
    const late = await createDraft(h.db, hana, { kind: "topic", ...L, title: "題", asksStance: true, altOf: target.id });
    if (!late.ok) throw new Error("draft failed");
    expect((await hideEntry(h.db, moderator, { entryId: target.id, reason: "spam", note: "n" })).ok).toBe(true);
    expect(await publishDraft(h.db, hana, late.id)).toEqual({ ok: false, error: "invalid_alt_of" });
    expect((await h.db.select().from(drafts).where(eq(drafts.id, late.id))).length).toBe(1);
    // Saving is allowed so unfinished drafts are not blocked.
    expect(code(await updateDraft(h.db, hana, late.id, { lang: "ja", body: "直した本文。", title: "題" }))).toBe("ok");
  });
});
