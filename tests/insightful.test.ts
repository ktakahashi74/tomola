import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, stanceChanges } from "~/lib/db/schema";
import { llmsTxt, helpAiMd } from "~/lib/api/guides.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { loadReviewTrigger, setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { getMd, parseThreadBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// "Insightful": the keys of the Markdown twins, and "Reconsider my stance" with the trigger of a stance change.
// The counts, the exclusion and the /vote answer are in tests/votes.test.ts; the reasons panel is in tests/reasons.test.ts.

// ---- the question page, the Markdown twins and the guides ----

describe("Insightful on the question page, in the Markdown twins and in the guides", () => {
  let h: RouteHarness;
  let q: number;
  let plainTopic: number;
  let otherQuestion: number;
  let own: number;
  let reply: number;
  let otherReply: number;
  let alienPost: number;
  const savedOperators = process.env.OPERATOR_EMAILS;

  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "operator-ins@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("somchai", { homeArea: "th", readLangs: ["th", "ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en", "ja"] });
    await h.signIn("lena", { homeArea: "fr", readLangs: ["fr", "ja"] });
    await h.signIn("ken", { homeArea: "ko", readLangs: ["ko", "ja"] });
    await h.signIn("opal", { homeArea: "ja", email: "operator-ins@example.com" });
    const question = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true });
    if (!question.ok) throw new Error("question failed");
    q = question.id;
    own = q;
    const r1 = await createReply(h.db, h.ids.somchai, q, { lang: "th", body: "ตอบ" });
    const r2 = await createReply(h.db, h.ids.lena, q, { lang: "fr", body: "réponse", stanceTag: "disagree" });
    if (!r1.ok || !r2.ok) throw new Error("reply failed");
    reply = r1.id;
    otherReply = r2.id;
    const plain = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "普通の話題", body: "本文" });
    const second = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "もう一つの問い", body: "命題です。", asksStance: true });
    if (!plain.ok || !second.ok) throw new Error("topic failed");
    plainTopic = plain.id;
    otherQuestion = second.id;
    const alien = await createReply(h.db, h.ids.somchai, otherQuestion, { lang: "th", body: "อื่น" });
    if (!alien.ok) throw new Error("reply failed");
    alienPost = alien.id;
    // john holds a stance on the question; lena holds none; ken chose one and withdrew it.
    expect((await setStance(h.db, h.ids.john, { questionId: q, position: "agree", expectedVersion: 0 })).ok).toBe(true);
    expect((await setStance(h.db, h.ids.ken, { questionId: q, position: "neither", expectedVersion: 0 })).ok).toBe(true);
    expect((await setStance(h.db, h.ids.ken, { questionId: q, position: null, expectedVersion: 1 })).ok).toBe(true);
    // everyone presses Insightful on the first reply and the question; john also on a reply of another question and on a plain topic's post
    for (const who of ["john", "lena", "ken"]) {
      await setVote(h.db, h.ids[who], q, true);
      await setVote(h.db, h.ids[who], reply, true);
    }
    await setVote(h.db, h.ids.john, alienPost, true);
    await setVote(h.db, h.ids.john, plainTopic, true);
  });
  afterAll(() => {
    h.restore();
    if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = savedOperators;
  });

  type Reactions = { insightful: { total: number; langs: number }; mine: boolean };
  type Post = { id: number; placeholder: string | null; reactions: Reactions; reviewHref: string | null };
  type Page = { topic: Post; replies: Post[]; question: { stance: { triggerEntryId: number | null } | null }; loadedAt: string };
  const page = async (as: string, id: number, query = "") => (await (await import("~/routes/topic")).loader(h.args(h.request(`/t/${id}${query}`, { as }), { id: String(id) }))) as unknown as Page;

  it("shows 'Reconsider my stance' (a link back to the stance panel of this question) only to a viewer who holds a stance, on posts inside a question's thread", async () => {
    const asJohn = await page("john", q);
    expect(asJohn.topic.reviewHref).toBe(`/t/${q}?review=${q}#stance`);
    expect(asJohn.replies.map((r) => r.reviewHref)).toEqual([`/t/${q}?review=${reply}#stance`, `/t/${q}?review=${otherReply}#stance`]);
    // no stance (lena), a withdrawn stance (ken): no link, so that nobody is nudged to choose one
    for (const as of ["lena", "ken", "somchai"]) {
      const p = await page(as, q);
      expect([p.topic.reviewHref, ...p.replies.map((r) => r.reviewHref)], as).toEqual([null, null, null]);
    }
    // a topic that is not a question has no stance, so no link, whoever presses Insightful there
    const plain = await page("john", plainTopic);
    expect(plain.topic.reviewHref).toBeNull();
    expect(plain.question.stance).toBeNull();
    expect(plain.topic.reactions).toEqual({ insightful: { total: 1, langs: 1 }, mine: true });
  });

  it("carries the language and the other query of the page into the link, and drops the one-time parameters", async () => {
    const { reviewHrefFor } = await import("~/lib/stance-ui");
    expect(reviewHrefFor(`/t/${q}`, "?lang=en&peek=1&stance_msg=conflict&stance_q=3&review=9", 7)).toBe(`/t/${q}?lang=en&review=7#stance`);
    expect(reviewHrefFor(`/t/${q}`, "", 7)).toBe(`/t/${q}?review=7#stance`);
  });

  it("builds document links after a production single-fetch revalidation, keeping the language query", async () => {
    const result = await (await import("~/routes/topic")).loader(h.args(h.request(`/t/${q}.data?lang=en&peek=1`, { as: "john" }), { id: String(q) })) as unknown as Page & {
      question: { reasons: Record<string, Array<{ id: number; reviewHref: string | null }>> };
    };
    expect(result.topic.reviewHref).toBe(`/t/${q}?lang=en&review=${q}#stance`);
    for (const post of result.replies) expect(post.reviewHref).toBe(`/t/${q}?lang=en&review=${post.id}#stance`);
    for (const post of Object.values(result.question.reasons).flat()) expect(post.reviewHref).toBe(`/t/${q}?lang=en&review=${post.id}#stance`);
  });

  it("hands the stance panel the post of ?review= only when that post may be the trigger (in this thread, not deleted or hidden, pressed by the viewer, and the viewer holds a stance); otherwise it is ignored", async () => {
    expect((await page("john", q, `?review=${reply}`)).question.stance?.triggerEntryId).toBe(reply);
    expect((await page("john", q, `?review=${q}`)).question.stance?.triggerEntryId).toBe(q);
    // not pressed by the viewer
    expect((await page("john", q, `?review=${otherReply}`)).question.stance?.triggerEntryId).toBeNull();
    // in another question's thread (john did press it)
    expect((await page("john", q, `?review=${alienPost}`)).question.stance?.triggerEntryId).toBeNull();
    // a post of a topic that is not in this thread
    expect((await page("john", q, `?review=${plainTopic}`)).question.stance?.triggerEntryId).toBeNull();
    // not a number, not in the database
    for (const bad of ["abc", "0", "-3", "1e2", "99999999", ""]) expect((await page("john", q, `?review=${bad}`)).question.stance?.triggerEntryId, bad).toBeNull();
    // a viewer without a stance, or who withdrew it
    for (const as of ["lena", "ken"]) expect((await page(as, q, `?review=${reply}`)).question.stance?.triggerEntryId, as).toBeNull();
    // none without the parameter
    expect((await page("john", q)).question.stance?.triggerEntryId).toBeNull();
    // a hidden or a deleted post
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply));
    expect(await loadReviewTrigger(h.db, h.ids.john, q, reply)).toBeNull();
    await h.db.update(entries).set({ hiddenAt: null, deletedAt: new Date() }).where(eq(entries.id, reply));
    expect(await loadReviewTrigger(h.db, h.ids.john, q, reply)).toBeNull();
    await h.db.update(entries).set({ deletedAt: null }).where(eq(entries.id, reply));
    expect(await loadReviewTrigger(h.db, h.ids.john, q, reply)).toBe(reply);
    expect(await loadReviewTrigger(h.db, h.ids.john, q, 987654)).toBeNull();
  });

  it("records the post as the trigger when the stance is changed from the link (and the author's area of that post), and records no trigger for a post the member did not press", async () => {
    const send = async (as: string, form: Record<string, string>) =>
      (await import("~/routes/stance")).action(h.args(h.request("/stance", { as, form: { questionId: String(q), ...form }, headers: { "sec-fetch-dest": "empty" } }))) as Awaited<Promise<unknown>>;
    // john changes agree -> disagree from the reply of somchai (Thai): the trigger and the trigger area are recorded
    await send("john", { position: "disagree", version: "1", trigger: String(reply) });
    const rows = await h.db.select().from(stanceChanges).where(eq(stanceChanges.userId, h.ids.john)).orderBy(stanceChanges.id);
    expect(rows.map((r) => [r.fromPosition, r.toPosition, r.triggerEntryId, r.triggerArea, r.area])).toEqual([
      [null, "agree", null, null, "en"],
      ["agree", "disagree", reply, "th", "en"],
    ]);
    // a hand-made trigger (a post john did not press) becomes "no trigger"; the change itself is recorded
    await send("john", { position: "neither", version: "2", trigger: String(otherReply) });
    // the question's own post as the trigger (john pressed Insightful on it): its author's area is recorded
    await send("john", { position: "agree", version: "3", trigger: String(own) });
    const after = await h.db.select().from(stanceChanges).where(eq(stanceChanges.userId, h.ids.john)).orderBy(stanceChanges.id);
    expect(after.slice(2).map((r) => [r.fromPosition, r.toPosition, r.triggerEntryId, r.triggerArea])).toEqual([
      ["disagree", "neither", null, null],
      ["neither", "agree", own, "ja"],
    ]);
  });

  it("gives the Insightful count of a topic in the Markdown twins as insightful and insightful_langs, and never a count per language or a cross-area number", async () => {
    const thread = parseThreadBlocks(await (await getMd(h, `/t/${q}.md`, { as: "hana" })).text());
    const [post, c1, c2] = thread;
    expect(post.fm).toMatchObject({ id: `p-${q}`, insightful: 3, insightful_langs: 3 });
    expect(c1.fm).toMatchObject({ id: `c-${reply}`, insightful: 3, insightful_langs: 3 });
    expect(c2.fm).toMatchObject({ id: `c-${otherReply}`, insightful: 0, insightful_langs: 0 });
    const lists = await Promise.all(["/latest.md", "/home.md", "/a/ja.md"].map(async (p) => (await getMd(h, p, { as: "hana" })).text()));
    for (const text of lists) {
      expect(text).toContain(`id: p-${q}`);
      expect(text).toMatch(/insightful: 3\n\s*insightful_langs: 3/);
    }
    for (const text of [...lists, JSON.stringify(thread)]) for (const word of ["votes_by_area", "insightful_by_area", "cross_area"]) expect(text, word).not.toContain(word);
  });

  it("does not count a member under exclude_reactions in the twins either, and counts them again when the exclusion ends", async () => {
    const { profiles } = await import("~/lib/db/schema");
    await h.db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, h.ids.lena));
    const excluded = parseThreadBlocks(await (await getMd(h, `/t/${q}.md`, { as: "hana" })).text());
    expect(excluded[0].fm).toMatchObject({ insightful: 2, insightful_langs: 2 });
    await h.db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, h.ids.lena));
    expect(parseThreadBlocks(await (await getMd(h, `/t/${q}.md`, { as: "hana" })).text())[0].fm).toMatchObject({ insightful: 3, insightful_langs: 3 });
  });

  it("explains Insightful in /llms.txt and /help/ai.md (a total and from how many languages; no vote per area, no cross-area)", () => {
    const llms = llmsTxt();
    for (const needle of ["Insightful", "insightful_langs", "new perspective", "not a vote of agreement", "Counts per language are not given in any file"]) expect(llms, needle).toContain(needle);
    for (const text of [llms, helpAiMd()]) for (const word of ["votes_by_area", "insightful_by_area", "cross_area", "There is deliberately no total", "votes per language area"]) expect(text, word).not.toContain(word);
  });

  describe("a trigger is used once (the URL keeps ?review= after the change)", () => {
    const send = async (as: string, form: Record<string, string>, headers: Record<string, string> = { "sec-fetch-dest": "empty" }) =>
      (await import("~/routes/stance")).action(h.args(h.request("/stance", { as, form: { questionId: String(q), ...form }, headers }))) as Awaited<Promise<unknown>>;
    const changesOf = async (userId: string) =>
      (await h.db.select().from(stanceChanges).where(eq(stanceChanges.userId, userId)).orderBy(stanceChanges.id)).map((r) => [r.fromPosition, r.toPosition, r.triggerEntryId, r.triggerArea]);

    it("records the post for the first change only: later changes from the same URL or the same form have no trigger, the loader stops offering it, and a withdrawal never has one", async () => {
      await h.signIn("mika", { homeArea: "en", readLangs: ["en", "ja"] });
      await setVote(h.db, h.ids.mika, reply, true);
      await setVote(h.db, h.ids.mika, q, true);
      expect((await setStance(h.db, h.ids.mika, { questionId: q, position: "agree", expectedVersion: 0 })).ok).toBe(true);
      // offered while it has not been used
      expect((await page("mika", q, `?review=${reply}`)).question.stance?.triggerEntryId).toBe(reply);
      await send("mika", { position: "disagree", version: "1", trigger: String(reply) });
      // the same URL again: the post was the trigger of a change, so it is not offered any more (the loader and setStance use one rule)
      expect((await page("mika", q, `?review=${reply}`)).question.stance?.triggerEntryId).toBeNull();
      expect(await loadReviewTrigger(h.db, h.ids.mika, q, reply)).toBeNull();
      // the same form sent again (a page loaded before the first change): disagree -> agree and agree -> neither carry no trigger
      await send("mika", { position: "agree", version: "2", trigger: String(reply) });
      await send("mika", { position: "neither", version: "3", trigger: String(reply) });
      // a withdrawal never has a trigger, even one that has not been used (the question's own post, which mika pressed)
      expect((await page("mika", q, `?review=${q}`)).question.stance?.triggerEntryId).toBe(q);
      await send("mika", { position: "none", version: "4", trigger: String(q) });
      expect(await changesOf(h.ids.mika)).toEqual([
        [null, "agree", null, null],
        ["agree", "disagree", reply, "th"],
        ["disagree", "agree", null, null],
        ["agree", "neither", null, null],
        ["neither", null, null, null],
      ]);
      // the withdrawal did not use the question's post: a later change can still record it, once
      await send("mika", { position: "agree", version: "5", trigger: String(q) });
      await send("mika", { position: "disagree", version: "6", trigger: String(q) });
      expect((await changesOf(h.ids.mika)).slice(5)).toEqual([
        [null, "agree", q, "ja"],
        ["agree", "disagree", null, null],
      ]);
    });

    it("applies the same rule when setStance is called directly (a hand-made form cannot reuse a post either), and one member's use does not use it up for another", async () => {
      // mika used both posts above; lena pressed both and holds no stance yet (a use by one member does not use the post up for another)
      expect((await setStance(h.db, h.ids.lena, { questionId: q, position: "agree", expectedVersion: 0, triggerEntryId: reply })).ok).toBe(true);
      expect((await setStance(h.db, h.ids.lena, { questionId: q, position: "disagree", expectedVersion: 1, triggerEntryId: reply })).ok).toBe(true);
      expect((await setStance(h.db, h.ids.lena, { questionId: q, position: "neither", expectedVersion: 2, triggerEntryId: q })).ok).toBe(true);
      expect(await changesOf(h.ids.lena)).toEqual([
        [null, "agree", reply, "th"],
        ["agree", "disagree", null, null],
        ["disagree", "neither", q, "ja"],
      ]);
    });

    it("leaves ?review= out of the return address of a form sent without JavaScript, so the change is the only one that carries it", async () => {
      const { stanceReturnTo } = await import("~/lib/stance-ui");
      const back = stanceReturnTo(`/t/${q}`, `?lang=en&review=${reply}&peek=1&stance_msg=conflict&stance_q=${q}`, "stance");
      expect(back).toBe(`/t/${q}?lang=en#stance`);
      expect(stanceReturnTo(`/t/${q}`, `?review=${reply}`, "stance")).toBe(`/t/${q}#stance`);
      // the browser is sent to that address after the change
      await h.signIn("noor", { homeArea: "en", readLangs: ["en", "ja"] });
      await setVote(h.db, h.ids.noor, reply, true);
      expect((await setStance(h.db, h.ids.noor, { questionId: q, position: "agree", expectedVersion: 0 })).ok).toBe(true);
      const result = (await send("noor", { position: "disagree", version: "1", trigger: String(reply), returnTo: back }, { "sec-fetch-dest": "document" }).catch((thrown: unknown) => thrown)) as Response;
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe(`/t/${q}?lang=en#stance`);
      expect(await changesOf(h.ids.noor)).toEqual([
        [null, "agree", null, null],
        ["agree", "disagree", reply, "th"],
      ]);
    });
  });
});
