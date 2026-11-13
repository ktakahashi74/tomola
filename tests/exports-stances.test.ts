import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, profiles } from "~/lib/db/schema";
import { createDraft } from "~/lib/drafts.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { buildMemberExport, buildObservationExport, MEMBER_EXPORT_VERSION, OBSERVATION_EXPORT_VERSION, type MemberExport } from "~/lib/exports.server";
import { setFollow } from "~/lib/follows.server";
import { excludeReactions, type Actor } from "~/lib/moderation.server";
import { setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The exports with the stances and Insightful. The member export gets the member's own stances and the history of changes (and calls the votes insightful); the observation
// export gets the questions with their distribution as members see it, and nothing that says who chose what. Every time is an argument.
const day = (n: number, hour = 0) => new Date(Date.UTC(2026, 8, n, hour));
const savedOperators = process.env.OPERATOR_EMAILS;
let h: RouteHarness;
let q: number; // a question by hana_x (ja)
let note: number; // a plain topic by hana_x
let alt: number; // another way of asking q, by ben_x (en)
let hiddenQ: number; // a question that is hidden afterwards
let r1: number; // a reply by ben_x to q, marked "disagree"

const OP: Actor = { id: "", scope: { operator: true, langs: [] } };

// hana_x (ja) asks a question and a plain topic. ben_x (en) writes the reply marked "disagree", another way of asking, and a question that is hidden afterwards. tia_stance_only (th) and
// sam_stance_only (en) never post: they choose stances and press Insightful. exm_excluded (en) does the same and is excluded afterwards.
beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "opal-x@example.com";
  h = await setupRouteHarness();
  await h.signIn("hana_x", { homeArea: "ja", readLangs: ["ja", "en"], email: "hana-x.secret@example.com" });
  await h.signIn("ben_x", { homeArea: "en", readLangs: ["en", "ja"], email: "ben-x.secret@example.com" });
  await h.signIn("tia_stance_only", { homeArea: "th", readLangs: ["th", "en"], email: "tia-x.secret@example.com" });
  await h.signIn("sam_stance_only", { homeArea: "en", readLangs: ["en"], email: "sam-x.secret@example.com" });
  await h.signIn("exm_excluded", { homeArea: "en", readLangs: ["en"], email: "exm-x.secret@example.com" });
  await h.signIn("opal_x", { homeArea: "en", readLangs: ["en"], email: "opal-x@example.com" });
  OP.id = h.ids.opal_x;
  const topic = async (as: string, input: Record<string, unknown>, at: Date) => {
    const res = await createTopic(h.db, h.ids[as], input, { now: at });
    if (!res.ok) throw new Error(`topic failed: ${res.error}`);
    return res.id;
  };
  q = await topic("hana_x", { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true }, day(1));
  note = await topic("hana_x", { lang: "ja", title: "ふつうの話題", body: "本文です。" }, day(2));
  alt = await topic("ben_x", { lang: "en", title: "Symbiosis can replace control only in part", body: "A narrower claim.", asksStance: true, altOf: q }, day(3));
  hiddenQ = await topic("ben_x", { lang: "en", title: "A question that gets hidden", body: "Body.", asksStance: true }, day(5));
  const reply = await createReply(h.db, h.ids.ben_x, q, { lang: "en", body: "I disagree with the premise.", stanceTag: "disagree" }, { now: day(4) });
  if (!reply.ok) throw new Error("reply failed");
  r1 = reply.id;
  const stance = async (as: string, question: number, position: "agree" | "disagree" | "neither" | null, at: Date, version: number, trigger?: number) => {
    const res = await setStance(h.db, h.ids[as], { questionId: question, position, expectedVersion: version, triggerEntryId: trigger ?? null }, { now: at });
    if (!res.ok) throw new Error(`stance failed: ${res.error}`);
  };
  const vote = async (as: string, entryId: number, at: Date) => expect((await setVote(h.db, h.ids[as], entryId, true, { now: at })).ok).toBe(true);
  await stance("hana_x", q, "agree", day(6, 0), 0);
  await stance("tia_stance_only", q, "agree", day(6, 1), 0);
  await stance("sam_stance_only", q, "agree", day(6, 2), 0);
  await stance("exm_excluded", q, "disagree", day(6, 3), 0);
  await stance("ben_x", alt, "neither", day(6, 4), 0);
  await stance("tia_stance_only", hiddenQ, "agree", day(6, 5), 0);
  await vote("tia_stance_only", r1, day(7, 0));
  await vote("hana_x", r1, day(7, 1));
  await vote("sam_stance_only", r1, day(7, 2));
  await vote("exm_excluded", r1, day(7, 3));
  await vote("tia_stance_only", note, day(7, 4));
  // tia reconsiders after pressing Insightful on ben's reply (the trigger): the change is prompted by a post of an "en" writer
  await stance("tia_stance_only", q, "disagree", day(8, 0), 1, r1);
  // Explicit following and unfollowing coexist with this member's stances and Insightful (version 4's rows survive the version 5 additions).
  expect((await setFollow(h.db, h.ids.tia_stance_only, q, true, { now: day(8, 1) })).ok).toBe(true);
  expect((await setFollow(h.db, h.ids.tia_stance_only, hiddenQ, true, { now: day(8, 2) })).ok).toBe(true);
  expect((await setFollow(h.db, h.ids.tia_stance_only, q, false, { now: day(8, 3) })).ok).toBe(true);
  // a draft of a question and a draft of a reply with a mark
  const draftQuestion = await createDraft(h.db, h.ids.ben_x, { kind: "topic", title: "Draft question", body: "b", lang: "en", asksStance: true });
  const draftReply = await createDraft(h.db, h.ids.ben_x, { kind: "reply", threadId: q, body: "b", lang: "en", stanceTag: "neither" });
  if (!draftQuestion.ok || !draftReply.ok) throw new Error("draft failed");
  expect((await excludeReactions(h.db, OP, { userId: h.ids.exm_excluded, reason: "spam", note: "a fake account" }, { now: day(9) })).ok).toBe(true);
  await h.db.update(entries).set({ hiddenAt: day(9) }).where(eq(entries.id, hiddenQ));
});
afterAll(() => {
  h.restore();
  if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = savedOperators;
});

const NOW = new Date("2026-10-15T00:00:00Z");

describe("the format versions", () => {
  it("went up from the integrated follow export and the previous observation export", () => {
    expect(MEMBER_EXPORT_VERSION).toBeGreaterThan(4);
    expect(OBSERVATION_EXPORT_VERSION).toBeGreaterThan(1);
  });
});

describe("the member export has the member's own stances and the history of changes", () => {
  it("lists the member's own stances (one row per question, the current one) and the changes (first registration, change with its trigger), and no one else's", async () => {
    const out = await buildMemberExport(h.db, h.ids.tia_stance_only, { now: NOW });
    expect(out.version).toBe(MEMBER_EXPORT_VERSION);
    expect(Object.keys(out)).toEqual(["ai_materials", "format", "nushi_sources", "push_subscriptions", "version", "generated_at", "profile", "entries", "drafts", "insightful", "stances", "stance_changes", "saved_topics", "follows", "village_icons", "village_follows", "signatures", "chat_messages"]);
    expect(out.chat_messages).toEqual([]);
    // the current stances: q is now "disagree" (version 2); hiddenQ is a question that was hidden afterwards: it is the member's own record, so it stays
    expect(out.stances).toEqual([
      { question_id: q, position: "disagree", area: "th", version: 2, created_at: day(6, 1).toISOString(), updated_at: day(8, 0).toISOString() },
      { question_id: hiddenQ, position: "agree", area: "th", version: 1, created_at: day(6, 5).toISOString(), updated_at: day(6, 5).toISOString() },
    ]);
    // the history: the first registration, then the change prompted by ben's reply (the post is only an id; trigger_area is the area of its author when it was written)
    expect(out.stance_changes).toEqual([
      { question_id: q, from_position: null, to_position: "agree", trigger_entry_id: null, trigger_area: null, area: "th", created_at: day(6, 1).toISOString() },
      { question_id: hiddenQ, from_position: null, to_position: "agree", trigger_entry_id: null, trigger_area: null, area: "th", created_at: day(6, 5).toISOString() },
      { question_id: q, from_position: "agree", to_position: "disagree", trigger_entry_id: r1, trigger_area: "en", area: "th", created_at: day(8, 0).toISOString() },
    ]);
    // the member's own Insightful, under the new name
    expect(out.insightful).toEqual([
      { entry_id: r1, voter_area: "th", created_at: day(7, 0).toISOString() },
      { entry_id: note, voter_area: "th", created_at: day(7, 4).toISOString() },
    ]);
    expect(out).not.toHaveProperty("votes");
    // Both states contain only this member's records, alongside the stances and Insightful asserted above.
    expect(out.follows).toEqual([
      { thread_id: q, state: "unfollowed", created_at: day(8, 1).toISOString(), updated_at: day(8, 3).toISOString() },
      { thread_id: hiddenQ, state: "following", created_at: day(8, 2).toISOString(), updated_at: day(8, 2).toISOString() },
    ]);
    // no other member's stance, handle or id
    const text = JSON.stringify(out);
    for (const secret of ["hana_x", "ben_x", "sam_stance_only", "exm_excluded", h.ids.hana_x, h.ids.ben_x, h.ids.sam_stance_only, h.ids.exm_excluded, "secret@example.com"]) expect(text, secret).not.toContain(secret);
  });

  it("has only the member's own rows for a member who posts too, and no count of the Insightful their posts got and no distribution of a question", async () => {
    const ben = await buildMemberExport(h.db, h.ids.ben_x, { now: NOW });
    // r1 got three presses from three languages; none of that is in ben's export
    expect(ben.insightful).toEqual([]);
    expect(ben.stances).toEqual([{ question_id: alt, position: "neither", area: "en", version: 1, created_at: day(6, 4).toISOString(), updated_at: day(6, 4).toISOString() }]);
    const text = JSON.stringify(ben);
    expect(text).not.toMatch(/insightful_langs|"total"|"counts"|"langs"|total_langs/);
    // the key set of the rows is exact (a new key must be added here on purpose)
    expect(Object.keys(ben.entries[0]).sort()).toEqual(
      ["alt_of", "ai_assistance", "asks_stance", "author_area", "body", "created_at", "edited_at", "id", "kind", "lang", "parent_id", "revisions", "signature_ids", "stance_tag", "status", "thread_id", "title", "via"].sort(),
    );
    expect(Object.keys(ben.drafts[0]).sort()).toEqual(
      ["alt_of", "ai_assistance", "asks_stance", "body", "created_at", "id", "kind", "lang", "parent_id", "raw_frontmatter", "stance_tag", "thread_id", "title", "updated_at", "version", "via"].sort(),
    );
    expect(Object.keys(ben.stances[0]).sort()).toEqual(["area", "created_at", "position", "question_id", "updated_at", "version"]);
  });

  it("carries the question marks of the member's posts and drafts: asks_stance, alt_of and stance_tag", async () => {
    const ben = await buildMemberExport(h.db, h.ids.ben_x, { now: NOW });
    const entry = (id: number) => ben.entries.find((e) => e.id === id)!;
    expect(entry(alt)).toMatchObject({ asks_stance: true, alt_of: q, stance_tag: null });
    expect(entry(r1)).toMatchObject({ asks_stance: false, alt_of: null, stance_tag: "disagree" });
    // a hidden question is still the member's own (status hidden)
    expect(entry(hiddenQ)).toMatchObject({ asks_stance: true, status: "hidden" });
    expect(ben.drafts.map((d) => [d.kind, d.asks_stance, d.alt_of, d.stance_tag])).toEqual([
      ["topic", true, null, null],
      ["reply", false, null, "neither"],
    ]);
    const hana = await buildMemberExport(h.db, h.ids.hana_x, { now: NOW });
    expect(hana.entries.map((e) => [e.id, e.asks_stance, e.alt_of, e.stance_tag])).toEqual([
      [q, true, null, null],
      [note, false, null, null],
    ]);
    // hana's own stance and her own press, nothing else
    expect(hana.stances.map((s) => [s.question_id, s.position])).toEqual([[q, "agree"]]);
    expect(hana.insightful.map((v) => v.entry_id)).toEqual([r1]);
  });

  it("a member with no stance and no press has empty lists", async () => {
    const opal = await buildMemberExport(h.db, h.ids.opal_x, { now: NOW });
    expect(opal.stances).toEqual([]);
    expect(opal.stance_changes).toEqual([]);
    expect(opal.insightful).toEqual([]);
    expect(opal.follows).toEqual([]);
  });

  it("is the route's body too (the settings export): the new keys, in a response that is private and not stored", async () => {
    const res = await h.outcome(() => import("~/routes/settings-export").then(async (m) => (await m.loader(h.args(h.request("/settings/export", { as: "tia_stance_only" }))))));
    expect(res.status).toBe(200);
    const response = res.value as Response;
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = JSON.parse(await response.text()) as MemberExport;
    expect(body.format).toBe("tomola-member-export");
    expect(body.version).toBe(MEMBER_EXPORT_VERSION);
    expect(body.stances).toHaveLength(2);
    expect(body.stance_changes).toHaveLength(3);
    expect(body.insightful).toHaveLength(2);
    expect(body.follows).toHaveLength(2);
    expect(body.follows[0]).toMatchObject({ thread_id: q, state: "unfollowed" });
  });
});

describe("the observation export has the questions with their distribution as members see it, and nothing that says who chose what", () => {
  const salt = Buffer.alloc(32, 3);

  it("lists the readable questions with exactly id, alt_of, created_at and distribution (total, counts, langs, as_of): a hidden question is not listed, a member under exclusion is not counted", async () => {
    const out = await buildObservationExport(h.db, { model: null, now: NOW, salt });
    expect(out.version).toBe(OBSERVATION_EXPORT_VERSION);
    expect(out.questions.map((x) => x.id)).toEqual([q, alt]);
    for (const question of out.questions) {
      expect(Object.keys(question).sort()).toEqual(["alt_of", "created_at", "distribution", "id"]);
      expect(Object.keys(question.distribution).sort()).toEqual(["as_of", "counts", "langs", "total"]);
      expect(Object.keys(question.distribution.counts).sort()).toEqual(["agree", "disagree", "neither"]);
    }
    // q: hana agree, tia disagree (changed), sam agree; exm (excluded) does not count: 3 stances (agree 2, disagree 1) from 3 languages (ja, th, en)
    expect(out.questions[0]).toEqual({
      id: q,
      alt_of: null,
      created_at: day(1).toISOString(),
      distribution: { total: 3, counts: { agree: 2, disagree: 1, neither: 0 }, langs: 3, as_of: NOW.toISOString() },
    });
    // alt: ben's neither only
    expect(out.questions[1]).toEqual({
      id: alt,
      alt_of: q,
      created_at: day(3).toISOString(),
      distribution: { total: 1, counts: { agree: 0, disagree: 0, neither: 1 }, langs: 1, as_of: NOW.toISOString() },
    });
  });

  it("has the question marks and the Insightful total and number of languages on each post (a member under exclusion is not counted), and nothing per language", async () => {
    const out = await buildObservationExport(h.db, { model: null, now: NOW, salt });
    const visible = (id: number) => out.entries.find((e) => e.id === id) as Extract<(typeof out.entries)[number], { status: "visible" }>;
    expect(visible(q)).toMatchObject({ asks_stance: true, alt_of: null, stance_tag: null, insightful: 0, insightful_langs: 0 });
    expect(visible(alt)).toMatchObject({ asks_stance: true, alt_of: q, stance_tag: null });
    expect(visible(note)).toMatchObject({ asks_stance: false, insightful: 1, insightful_langs: 1 });
    // r1: tia (th), hana (ja), sam (en) = 3 presses from 3 languages; exm (en, excluded) is not counted
    expect(visible(r1)).toMatchObject({ asks_stance: false, alt_of: null, stance_tag: "disagree", insightful: 3, insightful_langs: 3 });
    // a hidden question is metadata only
    expect(out.entries.find((e) => e.id === hiddenQ)).toEqual({ id: hiddenQ, kind: "topic", thread_id: hiddenQ, lang: "en", created_at: day(5).toISOString(), status: "hidden" });
    // the key set of a visible row is exact
    expect(Object.keys(visible(r1)).sort()).toEqual(
      ["ai_assistance", "alt_of", "asks_stance", "author", "author_area", "created_at", "edited_at", "id", "insightful", "insightful_langs", "kind", "lang", "stance_tag", "status", "thread_id", "translations", "via"].sort(),
    );
    expect(Object.keys(out).sort()).toEqual(
      ["ai_assistance", "author_key", "conformity_warnings", "divergence_summary", "divergences", "diversity", "embedding_model", "entries", "format", "generated_at", "questions", "version"].sort(),
    );
  });

  it("has no stance change rows, no identity of who chose what, no per-area stance number and none of the operator metrics, and says it is pseudonymous, not anonymous", async () => {
    const out = await buildObservationExport(h.db, { model: null, now: NOW, salt });
    const text = JSON.stringify(out);
    for (const secret of [
      "tia_stance_only",
      "sam_stance_only",
      "exm_excluded",
      "hana_x",
      "ben_x",
      "@example.com",
      h.ids.tia_stance_only,
      h.ids.sam_stance_only,
      h.ids.exm_excluded,
      h.ids.hana_x,
      h.ids.ben_x,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).not.toMatch(/stance_changes|from_position|to_position|trigger_entry|trigger_area|"stances"|by_area|byArea|voter_area|direction|matrix|insightful_by_area|votes_by_area/);
    expect(out.author_key.note).toMatch(/pseudonymous, NOT anonymous/i);
  });

  it("takes the excluded member back into the counts when the exclusion is lifted", async () => {
    // the exclusion is an operator action on profiles.reactions_excluded_at; lifting it brings the stance and the Insightful back
    const before = await buildObservationExport(h.db, { model: null, now: NOW, salt });
    await h.db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, h.ids.exm_excluded));
    const after = await buildObservationExport(h.db, { model: null, now: NOW, salt });
    expect(after.questions[0].distribution).toMatchObject({ total: 4, counts: { agree: 2, disagree: 2, neither: 0 }, langs: 3 });
    expect((after.entries.find((e) => e.id === r1) as { insightful: number }).insightful).toBe(4);
    expect(before.questions[0].distribution.total).toBe(3);
    await h.db.update(profiles).set({ reactionsExcludedAt: day(9) }).where(eq(profiles.userId, h.ids.exm_excluded));
  });
});

// The column ai_assistance is nullable (a post written on the screen has no value). Both exports pass a null through as null. The nullable-column migration is emulated on a database
// of this test to verify both export formats against the same schema.
describe("a null ai_assistance is exported as null", () => {
  it("in both exports", async () => {
    const db = await createTestDb();
    await addMember(db, "ann", "ann_null", { homeArea: "ja" });
    const topic = await createTopic(db, "ann", { lang: "ja", title: "t", body: "b", aiAssistance: "polish" }, { now: day(1) });
    if (!topic.ok) throw new Error("topic failed");
    const draft = await createDraft(db, "ann", { kind: "topic", title: "d", body: "b", lang: "ja", aiAssistance: "draft" });
    if (!draft.ok) throw new Error("draft failed");
    await db.execute(sql`alter table entries alter column ai_assistance drop not null`);
    await db.execute(sql`alter table drafts alter column ai_assistance drop not null`);
    await db.execute(sql`update entries set ai_assistance = null`);
    await db.execute(sql`update drafts set ai_assistance = null`);
    const member = await buildMemberExport(db, "ann", { now: NOW });
    expect(member.entries[0].ai_assistance).toBeNull();
    expect(member.drafts[0].ai_assistance).toBeNull();
    expect(JSON.parse(JSON.stringify(member)).entries[0]).toHaveProperty("ai_assistance", null);
    const observed = await buildObservationExport(db, { model: null, now: NOW, salt: Buffer.alloc(32, 1) });
    expect(JSON.parse(JSON.stringify(observed)).entries[0]).toHaveProperty("ai_assistance", null);
    // a value that is there is exported as it is
    await db.execute(sql`update entries set ai_assistance = 'polish'`);
    expect((await buildMemberExport(db, "ann", { now: NOW })).entries[0].ai_assistance).toBe("polish");
  });
});
