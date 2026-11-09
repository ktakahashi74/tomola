import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { entries, glossaryEntries, jobs, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { getFollowState } from "~/lib/follows.server";
import { glossaryProposalPrefill, inlineCode, oneLine, TITLE_TERM_MAX, titleTerm } from "~/lib/glossary-proposal.server";
import { createGlossaryEntry, deleteGlossaryEntry, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { LANGS, type Lang } from "~/lib/languages";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { m } from "~/paraglide/messages.js";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The template of a translation proposal: /t/new?asks_stance=1&propose_term=1&entry=<id>, or &from=&to=. The server builds it from checked values only.
// A proposal is an ordinary "asks a stance" post. The tests read the real messages (messages/<locale>.json), not the empty stubs.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const ja = { locale: "ja" as const };
const en = { locale: "en" as const };

const op: GlossaryActor = { userId: "op", scope: { operator: true, langs: [] } };
const params = (query: string) => new URLSearchParams(query);
const prefill = (db: Awaited<ReturnType<typeof createTestDb>>, query: string, locale: Lang = "ja", enabled: readonly Lang[] = LANGS) => glossaryProposalPrefill(db, params(query), { locale, enabled });

async function setup() {
  const db = await createTestDb();
  await addMember(db, "op", "opal");
  await addMember(db, "u1", "hana");
  const made = await createGlossaryEntry(db, op, { term: "corrigibility", lang: "en", targetLang: "ja", candidates: "修正可能性\nコリジビリティ" });
  if (!made.ok) throw new Error("create failed");
  return { db, entryId: made.id };
}

describe("the template of a proposal", () => {
  it("is not made without propose_term=1: the ordinary new-topic screen stays as it is", async () => {
    const { db, entryId } = await setup();
    expect(await prefill(db, "")).toBeNull();
    expect(await prefill(db, `asks_stance=1&entry=${entryId}`)).toBeNull();
    expect(await prefill(db, `propose_term=0&entry=${entryId}`)).toBeNull();
    expect(await prefill(db, `propose_term=true&entry=${entryId}`)).toBeNull();
  });

  it("for an entry puts the term, the language of the term, the target language and the current candidates in the title and the body, in the language of the member's posts (Japanese)", async () => {
    const { db, entryId } = await setup();
    const got = await prefill(db, `asks_stance=1&propose_term=1&entry=${entryId}`, "ja");
    expect(got).toEqual({
      title: m.proposal_title_entry({ term: "corrigibility", target: "日本語" }, ja),
      body: [m.proposal_body_term({ term: "`corrigibility`" }, ja), m.proposal_body_term_lang({ lang: "英語（en）" }, ja), m.proposal_body_target_lang({ lang: "日本語（ja）" }, ja), m.proposal_body_current({ candidates: "`修正可能性`、`コリジビリティ`" }, ja), m.proposal_body_proposed({}, ja), m.proposal_body_reason({}, ja), ""].join("\n"),
    });
    // A member who mainly writes English gets the English template (the default language of posts, not the language of the screen)
    const english = await prefill(db, `propose_term=1&entry=${entryId}`, "en");
    expect(english).toEqual({
      title: m.proposal_title_entry({ term: "corrigibility", target: "Japanese" }, en),
      body: [m.proposal_body_term({ term: "`corrigibility`" }, en), m.proposal_body_term_lang({ lang: "English (en)" }, en), m.proposal_body_target_lang({ lang: "Japanese (ja)" }, en), m.proposal_body_current({ candidates: "`修正可能性`, `コリジビリティ`" }, en), m.proposal_body_proposed({}, en), m.proposal_body_reason({}, en), ""].join("\n"),
    });
    // The language tag is added to the name, so that Simplified and Traditional Chinese are not mixed up
    const hans = await createGlossaryEntry(db, op, { term: "alignment", lang: "en", targetLang: "zh-Hans", candidates: "对齐" });
    if (!hans.ok) throw new Error("create failed");
    expect((await prefill(db, `propose_term=1&entry=${hans.id}`, "en"))?.body).toContain(m.proposal_body_target_lang({ lang: "Chinese (Simplified) (zh-Hans)" }, en));
  });

  it("for a new term uses the languages of the page (from and to) only when they are valid and different, and leaves the term empty; English is not the default", async () => {
    const { db } = await setup();
    expect(await prefill(db, "propose_term=1&from=fr&to=ja", "ja")).toEqual({
      title: m.proposal_title_new({ target: "日本語" }, ja),
      body: [m.proposal_body_term({ term: "` `" }, ja), m.proposal_body_term_lang({ lang: "フランス語（fr）" }, ja), m.proposal_body_target_lang({ lang: "日本語（ja）" }, ja), m.proposal_body_proposed({}, ja), m.proposal_body_reason({}, ja), ""].join("\n"),
    });
    // Only to: the language of the term is left empty (English is not the default)
    const toOnly = await prefill(db, "propose_term=1&to=de", "ja");
    expect(toOnly?.body).toContain(`${m.proposal_body_term_lang({ lang: "" }, ja)}\n`);
    expect(toOnly?.body).toContain(m.proposal_body_target_lang({ lang: "ドイツ語（de）" }, ja));
    expect(toOnly?.title).toBe(m.proposal_title_new({ target: "ドイツ語" }, ja));
    // Neither: the empty template
    expect(await prefill(db, "propose_term=1", "ja")).toEqual({
      title: m.proposal_title_blank({}, ja),
      body: [m.proposal_body_term({ term: "` `" }, ja), m.proposal_body_term_lang({ lang: "" }, ja), m.proposal_body_target_lang({ lang: "" }, ja), m.proposal_body_proposed({}, ja), m.proposal_body_reason({}, ja), ""].join("\n"),
    });
    // The same language twice, an invalid tag, and a language that is not enabled are left out
    expect(await prefill(db, "propose_term=1&from=ja&to=ja")).toEqual(await prefill(db, "propose_term=1"));
    expect(await prefill(db, "propose_term=1&from=xx&to=yy")).toEqual(await prefill(db, "propose_term=1"));
    expect(await prefill(db, "propose_term=1&from=<script>&to=ja%00")).toEqual(await prefill(db, "propose_term=1"));
    expect(await prefill(db, "propose_term=1&from=fr&to=de", "ja", ["ja", "en"])).toEqual(await prefill(db, "propose_term=1"));
    expect((await prefill(db, "propose_term=1&from=en&to=de", "ja", ["ja", "en"]))?.body).toContain(`${m.proposal_body_term_lang({ lang: "英語（en）" }, ja)}\n${m.proposal_body_target_lang({ lang: "" }, ja)}\n`);
  });

  it("an id that is not an entry, or the id of a deleted entry, gives the empty template", async () => {
    const { db, entryId } = await setup();
    const blank = await prefill(db, "propose_term=1");
    for (const entry of ["99999", "0", "-1", "abc", "1e2", "", `${entryId}x`]) expect(await prefill(db, `propose_term=1&entry=${entry}`), entry).toEqual(blank);
    expect(await deleteGlossaryEntry(db, op, entryId)).toEqual({ ok: true });
    expect(await prefill(db, `propose_term=1&entry=${entryId}`)).toEqual(blank);
  });

  it("writes the term and the translation as inline code, so that a translation of the post leaves them alone; a term with backticks gets a longer fence", async () => {
    expect(inlineCode("corrigibility")).toBe("`corrigibility`");
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("a``b`c")).toBe("```a``b`c```");
    expect(inlineCode("`edge")).toBe("`` `edge ``");
    expect(inlineCode("edge`")).toBe("`` edge` ``");
    const { db } = await setup();
    const odd = await createGlossaryEntry(db, op, { term: "a`b", lang: "en", targetLang: "ja", candidates: "x`y" });
    if (!odd.ok) throw new Error("create failed");
    expect((await prefill(db, `propose_term=1&entry=${odd.id}`))?.body).toContain(m.proposal_body_term({ term: "``a`b``" }, ja));
    expect((await prefill(db, `propose_term=1&entry=${odd.id}`))?.body).toContain(m.proposal_body_current({ candidates: "``x`y``" }, ja));
  });

  it("keeps every line of the template to one line: a term cannot carry a line break any more, and a row written before that rule cannot start a Markdown block in the body", async () => {
    const { db, entryId } = await setup();
    // The glossary refuses a term or a candidate with a line break
    expect(await createGlossaryEntry(db, op, { term: "evil\n\n# Heading\n- injected", lang: "en", targetLang: "ja", candidates: "x" })).toEqual({ ok: false, error: "invalid_term" });
    expect(await createGlossaryEntry(db, op, { term: "evil", lang: "en", targetLang: "ja", candidates: ["x\n```\nblock"] })).toEqual({ ok: false, error: "invalid_candidates" });
    // A legacy row (written directly, as the data of an older version could be) is flattened when the template is made
    const [legacy] = await db.insert(glossaryEntries).values({ term: "legacy\n\n# Heading\n- injected\u2028x", lang: "en", targetLang: "ja", candidates: ["a\n```\nblock", "\n\t "], updatedBy: "op" }).returning({ id: glossaryEntries.id });
    for (const id of [entryId, legacy.id]) {
      const got = await prefill(db, `propose_term=1&entry=${id}`, "ja");
      const lines = (got?.body ?? "").split("\n");
      // Six lines of the template for an entry (term, term language, target language, current candidates, proposed, reason) and the empty one after the last newline
      expect(lines, String(id)).toHaveLength(7);
      expect(lines.slice(0, 6).every((l) => l.startsWith("- ")), String(id)).toBe(true);
      expect(got?.title).not.toMatch(/[\n\r\u2028\u2029]/);
    }
    const flat = await prefill(db, `propose_term=1&entry=${legacy.id}`, "ja");
    expect(flat?.body).toContain(m.proposal_body_term({ term: "`legacy # Heading - injected x`" }, ja));
    // The candidate has a run of three backticks, so its fence is four
    expect(flat?.body).toContain(m.proposal_body_current({ candidates: "````a ``` block````" }, ja));
    expect(oneLine("a\n\nb\tc\u2029d")).toBe("a b c d");
  });

  it("cuts a long term in the title (a topic's title is at most 200 characters) and keeps the whole term in the body", async () => {
    const { db } = await setup();
    const long = "長い語".repeat(60).slice(0, 190);
    const made = await createGlossaryEntry(db, op, { term: long, lang: "ja", targetLang: "en", candidates: "x" });
    if (!made.ok) throw new Error("create failed");
    const got = await prefill(db, `propose_term=1&entry=${made.id}`, "en");
    expect(got?.title).toBe(m.proposal_title_entry({ term: `${[...long].slice(0, TITLE_TERM_MAX).join("")}…`, target: "English" }, en));
    expect((got?.title ?? "").length).toBeLessThanOrEqual(200);
    expect(got?.body).toContain(m.proposal_body_term({ term: `\`${long}\`` }, en));
    expect(titleTerm("short")).toBe("short");
    expect([...titleTerm("x".repeat(TITLE_TERM_MAX))].length).toBe(TITLE_TERM_MAX);
    expect(titleTerm("x".repeat(TITLE_TERM_MAX + 1)).endsWith("…")).toBe(true);
    // Counted in code points: an emoji is one character, not two
    expect([...titleTerm("😀".repeat(TITLE_TERM_MAX + 5))]).toHaveLength(TITLE_TERM_MAX + 1);
  });

  it("does not read ?title= or ?body=, and puts nothing from the URL into the text except the checked values", async () => {
    const { db, entryId } = await setup();
    const clean = await prefill(db, `propose_term=1&entry=${entryId}`);
    const crafted = await prefill(db, `propose_term=1&entry=${entryId}&title=EVIL-TITLE&body=EVIL-BODY&term=EVIL-TERM&lang=EVIL-LANG&candidates=EVIL`);
    expect(crafted).toEqual(clean);
    const blank = await prefill(db, "propose_term=1&title=EVIL&body=EVIL&from=EVIL&to=EVIL");
    expect(JSON.stringify(blank)).not.toContain("EVIL");
  });
});

// ---- the new-topic screen ----

describe("the new-topic screen", () => {
  let h: RouteHarness;
  let entryId: number;
  let proposalTopicId: number;
  const route = () => import("~/routes/topic-new");
  const load = async (query: string, as = "aki") => ((await (await route()).loader(await h.signedArgs(h.request(`/t/new${query}`, { as })))) as Awaited<Promise<Record<string, unknown>>>);

  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("aki", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("ben", { homeArea: "en", readLangs: ["en"] });
    await h.signIn("op");
    const made = await createGlossaryEntry(h.db, { userId: h.ids.op, scope: { operator: true, langs: [] } }, { term: "corrigibility", lang: "en", targetLang: "ja", candidates: "修正可能性" });
    if (!made.ok) throw new Error("create failed");
    entryId = made.id;
  });
  afterAll(() => h.restore());

  it("opens the same as before without propose_term, and with the template and 'asks a stance' switched on with it (even without asks_stance=1)", async () => {
    const plain = await load("");
    expect(plain).toMatchObject({ prefill: null, asksStance: false, defaultLang: "ja", alt: null });
    expect(await load("?asks_stance=1")).toMatchObject({ prefill: null, asksStance: true });
    expect(await load(`?asks_stance=1&entry=${entryId}`)).toMatchObject({ prefill: null });
    const proposal = await load(`?asks_stance=1&propose_term=1&entry=${entryId}`);
    expect(proposal).toMatchObject({ asksStance: true, prefill: { title: m.proposal_title_entry({ term: "corrigibility", target: "日本語" }, ja) } });
    expect((proposal.prefill as { body: string }).body).toContain(m.proposal_body_current({ candidates: "`修正可能性`" }, ja));
    expect(await load(`?propose_term=1&entry=${entryId}`)).toMatchObject({ asksStance: true });
    expect(await load("?propose_term=1&from=fr&to=ja")).toMatchObject({ asksStance: true, prefill: { title: m.proposal_title_new({ target: "日本語" }, ja) } });
  });

  it("writes the template in the language of the member's posts: an English member gets English", async () => {
    const english = await load(`?propose_term=1&entry=${entryId}`, "ben");
    expect(english).toMatchObject({ defaultLang: "en", prefill: { title: m.proposal_title_entry({ term: "corrigibility", target: "Japanese" }, en) } });
  });

  it("puts the link to the original question first when alt_of comes with it: no template", async () => {
    const original = await createTopic(h.db, h.ids.aki, { lang: "ja", title: "元の問い", body: "本文", asksStance: true });
    if (!original.ok) throw new Error("topic failed");
    const alt = await load(`?propose_term=1&entry=${entryId}&alt_of=${original.id}`);
    expect(alt).toMatchObject({ prefill: null, asksStance: true, alt: { id: original.id } });
    // No template even when the original question cannot be read
    expect(await load(`?propose_term=1&entry=${entryId}&alt_of=99999`)).toMatchObject({ prefill: null, altNotFound: true });
  });

  it("posting the template makes an ordinary question: asks a stance, translation jobs, nothing marked as a proposal; the code spans survive the translation", async () => {
    const t = (await load(`?propose_term=1&entry=${entryId}`)).prefill as { title: string; body: string };
    const body = t.body.replace(m.proposal_body_proposed({}, ja), m.proposal_body_proposed({}, ja).replace("` `", "`矯正可能性`")).replace(m.proposal_body_reason({}, ja), `${m.proposal_body_reason({}, ja)}人が止められるという意味に近いから`);
    const posted = await h.outcome(async () => (await route()).action(await h.signedArgs(h.request("/t/new", { as: "aki", form: { title: t.title.replace("「　」", "「矯正可能性」"), body, asksStance: "1", lang: "ja" } }))));
    expect(posted.status).toBe(302);
    proposalTopicId = Number(new URL(posted.location!, "http://localhost").pathname.split("/").pop());
    const [topic] = await h.db.select().from(entries).where(eq(entries.id, proposalTopicId));
    expect(posted.location).toBe(`/t/${topic.id}?posted=${topic.id}`);
    expect(topic).toMatchObject({ kind: "topic", asksStance: true, lang: "ja" });
    // No mark and no column: nothing about a proposal is attached to the post
    expect(Object.keys(topic).filter((k) => /propos|glossary|term/i.test(k))).toEqual([]);
    expect((await h.db.select().from(jobs)).some((j) => j.kind.includes("translate"))).toBe(true);
    await runDueJobs(h.db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } }), { now: new Date(), limit: 500, logger: { error() {}, warn() {} } });
    const thai = (await h.db.select().from(translations).where(eq(translations.entryId, topic.id))).find((r) => r.lang === "th" && r.field === "body");
    expect(thai?.text).toContain("`corrigibility`");
    expect(thai?.text).toContain("`矯正可能性`");
  });

  it("the proposal's author follows it like any topic, and nobody else does", async () => {
    expect(await getFollowState(h.db, h.ids.aki, proposalTopicId)).toBe("following");
    expect(await getFollowState(h.db, h.ids.ben, proposalTopicId)).toBeNull();
  });

  it("changing the glossary on the strength of a proposal leaves the proposal post and its replies as they were; the proposal is a link recorded in the history, nothing more", async () => {
    const [topic] = await h.db.select().from(entries).where(eq(entries.id, proposalTopicId));
    const reply = await createReply(h.db, h.ids.ben, topic.id, { lang: "en", body: "I prefer 矯正可能性." });
    if (!reply.ok) throw new Error("reply failed");
    const before = JSON.stringify(await h.db.select().from(entries).orderBy(asc(entries.id)));
    const actor = { userId: h.ids.op, scope: { operator: true, langs: [] as Lang[] } };
    expect(await updateGlossaryEntry(h.db, actor, entryId, { term: "corrigibility", candidates: "矯正可能性\n修正可能性" }, { proposal: String(topic.id) })).toEqual({ ok: true, changed: true });
    expect(JSON.stringify(await h.db.select().from(entries).orderBy(asc(entries.id)))).toBe(before);
  });

  it("with ENABLED_LANGS the template is written in the language of defaultPostLang, and a from or to that is not enabled is left out", async () => {
    // Members are created while every language is enabled: one whose main language will be closed, and one who chose "other"
    await h.signIn("fumi", { homeArea: "fr", readLangs: ["fr", "ja"] });
    await h.signIn("otto", { homeArea: "other", readLangs: ["en", "ja"] });
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    try {
      // main language fr is not enabled: the first enabled language the member reads (ja)
      const fumi = await load(`?propose_term=1&from=fr&to=ja`, "fumi");
      expect(fumi).toMatchObject({ defaultLang: "ja", prefill: { title: m.proposal_title_new({ target: "日本語" }, ja) } });
      // fr is not enabled, so it is left out of the template (the language of the term stays empty)
      expect((fumi.prefill as { body: string }).body).toContain(`${m.proposal_body_term_lang({ lang: "" }, ja)}\n`);
      expect((fumi.prefill as { body: string }).body).not.toContain("フランス語");
      // "other": the first enabled language the member reads (en)
      const otto = await load(`?propose_term=1&to=ja&from=en`, "otto");
      expect(otto).toMatchObject({ defaultLang: "en" });
      expect((otto.prefill as { title: string }).title).toBe(m.proposal_title_new({ target: "Japanese" }, en));
      // the main language, when it is enabled, wins
      expect(await load(`?propose_term=1&entry=${entryId}`, "ben")).toMatchObject({ defaultLang: "en" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
