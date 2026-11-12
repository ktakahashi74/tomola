import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { quietLogger } from "./helpers/logger";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { jobs, llmUsage, profiles, villageMembers, villageTranslations, villages } from "~/lib/db/schema";
import type { Db } from "~/lib/db/client.server";
import { createVillageTranslationHandlers } from "~/lib/jobs/village-translation-jobs.server";
import { jobHandlers } from "~/lib/jobs/handlers.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { buildTranslationPrompt, VILLAGE_PROMPT_VERSION } from "~/lib/llm/prompt.server";
import type { TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { createVillage, editVillage, inviteToVillage } from "~/lib/village-management.server";
import { joinedVillageNavigation } from "~/lib/village-navigation.server";
import { listNotifications } from "~/lib/notifications.server";
import { applyVillageTexts, decideVillageLang, decideVillageLangOf, detectedVillageLang, SAME_AS_SOURCE, localizeVillage, localizeVillages, planVillageTexts, requestVillageTranslations, villageReaderOfMember, villageSourceHash } from "~/lib/village-translations.server";
import { prepareVillages, runPrepareVillages } from "~/lib/villages-prepare.server";
import { hitMemberLimit } from "~/lib/rate-limit.server";
import { villageNameLang } from "~/lib/village-translation-view";
import { changeVillageMembership, ensureLanguageVillages, listJoinedVillages, listVillages, postingVillages } from "~/lib/villages.server";
import { buildListMarkdown } from "~/lib/md/lists.server";
import { translatedVillageDescription, translatedVillageName } from "~/lib/villages";
import { loader as villageLoader } from "~/routes/village";
import { loader as villagesLoader } from "~/routes/villages";

it("keeps ambiguous Han village text in the author's main language", () => {
  const env = { ENABLED_LANGS: "ja,en,zh-Hans,zh-Hant" };
  const author = { homeArea: "ja", uiLocale: null, displayLang: null, readLangs: ["ja"] };
  expect(decideVillageLang({ name: "学会", description: "時間変更" }, author, env)).toEqual({ lang: "ja", by: "author" });
  expect(detectedVillageLang("確認", env, author.homeArea)).toBe("ja");
  expect(detectedVillageLang("確認", env)).toBe("zh-Hant");
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const t0 = new Date("2026-10-25T00:00:00Z");
const engines = (primary: TranslationEngine = createFakeEngine()): EngineSet => ({ primary, secondary: null, judge: null });
const run = (db: Db, primary?: TranslationEngine) => runDueJobs(db, createVillageTranslationHandlers({ llm: { engines: engines(primary) } }), { now: t0, logger: quietLogger, limit: 100 });
const rows = (db: Db, id?: string) => db.select().from(villageTranslations).where(id ? eq(villageTranslations.villageId, id) : undefined).orderBy(villageTranslations.villageId, villageTranslations.lang);
const village = async (db: Db, slug: string) => (await db.select().from(villages).where(eq(villages.slug, slug)))[0];

async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "vt_author", "vt_author", { homeArea: "ja", readLangs: ["ja"] });
  await addMember(db, "vt_reader", "vt_reader", { homeArea: "en", readLangs: ["en"] });
  const made = await createVillage(db, "vt_author", { slug: "kyoto", kind: "open", name: "京都の会", description: "京都で集まります。\n毎月第一土曜日です。" });
  expect(made).toEqual({ ok: true, slug: "kyoto" });
  return { db, id: (await village(db, "kyoto")).id };
}

describe("the language of a village and the jobs it queues", () => {
  it("takes the author's main language, or the one they name, and queues one job per other enabled language without the texts", async () => {
    const { db, id } = await world();
    const v = await village(db, "kyoto");
    expect(v.sourceLang).toBe("ja");
    const queued = await db.select().from(jobs).where(eq(jobs.kind, "translate_village"));
    expect(queued.map(job => job.payload)).toEqual(expect.arrayContaining([{ villageId: id, lang: "en", sourceHash: villageSourceHash(v) }, { villageId: id, lang: "fr", sourceHash: villageSourceHash(v) }]));
    expect(queued).toHaveLength(2);
    expect(queued.every(job => job.maxAttempts === 5 && Object.keys(job.payload as object).sort().join() === "lang,sourceHash,villageId")).toBe(true);
    expect((await rows(db, id)).map(row => [row.lang, row.state])).toEqual([["en", "pending"], ["fr", "pending"]]);
    // A named language wins over the main language; a language that is not enabled is refused.
    expect(await createVillage(db, "vt_author", { slug: "paris", kind: "open", name: "Paris", description: "", sourceLang: "fr" })).toMatchObject({ ok: true });
    expect((await village(db, "paris")).sourceLang).toBe("fr");
    expect(await createVillage(db, "vt_author", { slug: "seoul", kind: "open", name: "Seoul", description: "", sourceLang: "ko" })).toEqual({ ok: false, error: "invalid" });
    // The author whose main language is "other" gets the language of their screen.
    await addMember(db, "vt_other", "vt_other", { homeArea: "other" });
    await db.update(profiles).set({ uiLocale: "fr" }).where(eq(profiles.userId, "vt_other"));
    await createVillage(db, "vt_other", { slug: "lyon", kind: "open", name: "Lyon", description: "" });
    expect((await village(db, "lyon")).sourceLang).toBe("fr");
  });

  it("queues again only when the texts or the language change, and drops what the old texts made", async () => {
    const { db, id } = await world();
    await run(db);
    expect((await rows(db, id)).map(row => row.state)).toEqual(["ready", "ready"]);
    const before = (await db.select().from(jobs).where(eq(jobs.kind, "translate_village"))).length;
    // Saving the same texts again changes nothing.
    expect(await editVillage(db, "vt_author", "kyoto", { name: "京都の会", description: "京都で集まります。\n毎月第一土曜日です。" })).toMatchObject({ ok: true });
    expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_village"))).toHaveLength(before);
    expect((await rows(db, id)).map(row => row.state)).toEqual(["ready", "ready"]);
    // A new name: the old translations are gone at once (no old text is shown), and new ones are pending.
    await editVillage(db, "vt_author", "kyoto", { name: "京都の集い", description: "京都で集まります。\n毎月第一土曜日です。" });
    expect((await rows(db, id)).map(row => [row.state, row.name])).toEqual([["pending", null], ["pending", null]]);
    // A new language: translated into the other languages, and not into the new original.
    await editVillage(db, "vt_author", "kyoto", { name: "京都の集い", description: "京都で集まります。\n毎月第一土曜日です。", sourceLang: "en" });
    expect((await rows(db, id)).map(row => row.lang)).toEqual(["fr", "ja"]);
    expect((await village(db, "kyoto")).sourceLang).toBe("en");
    // Unstarted jobs of earlier texts are removed; only the current ones are left.
    const current = villageSourceHash(await village(db, "kyoto"));
    expect((await db.select().from(jobs).where(and(eq(jobs.kind, "translate_village"), eq(jobs.status, "queued")))).every(job => (job.payload as { sourceHash: string }).sourceHash === current)).toBe(true);
    expect(await editVillage(db, "vt_author", "kyoto", { name: "x", description: "", sourceLang: "ko" })).toEqual({ ok: false, error: "invalid" });
  });

  it("does not translate a language village's name, only a description an operator wrote; nothing for a village without texts or a closed one", async () => {
    const { db } = await world();
    const en = await village(db, "en");
    expect(await requestVillageTranslations(db, en.id)).toBe(0);
    await db.update(villages).set({ description: "Where English is read.", sourceLang: "en" }).where(eq(villages.id, en.id));
    expect(await requestVillageTranslations(db, en.id)).toBe(2);
    await run(db);
    expect((await rows(db, en.id)).map(row => [row.lang, row.name, row.description])).toEqual([["fr", null, "[fr] Where English is read."], ["ja", null, "[ja] Where English is read."]]);
    const [closed] = await db.insert(villages).values({ slug: "secret", kind: "closed", name: "Secret", description: "Hidden", sourceLang: "en" }).returning();
    expect(await requestVillageTranslations(db, closed.id)).toBe(0);
    const [empty] = await db.insert(villages).values({ slug: "blank", kind: "open", name: "", description: "", sourceLang: "en" }).returning();
    expect(await requestVillageTranslations(db, empty.id)).toBe(0);
  });
});

describe("the translation job", () => {
  it("translates the name and the description as short plain text, with the same engine and budget as posts, and keeps the checked result", async () => {
    const { db, id } = await world();
    const requests: TranslationRequest[] = [];
    const recording: TranslationEngine = { ...createFakeEngine(), async translate(req) { requests.push(req); return createFakeEngine().translate(req); } };
    const stats = await run(db, recording);
    expect(stats).toMatchObject({ done: 2, failed: 0 });
    expect(requests.map(req => [req.to, req.village, req.text])).toEqual([
      ["en", "name", "京都の会"], ["en", "description", "京都で集まります。\n毎月第一土曜日です。"],
      ["fr", "name", "京都の会"], ["fr", "description", "京都で集まります。\n毎月第一土曜日です。"],
    ]);
    // Nothing of any other text goes with the request.
    for (const req of requests) expect(req).not.toHaveProperty("titleBodyContext");
    expect(requests.every(req => req.from === "ja" && !req.chat && !req.context && !req.title)).toBe(true);
    expect(await rows(db, id)).toMatchObject([
      { lang: "en", state: "ready", name: "[en] 京都の会", description: "[en] 京都で集まります。\n毎月第一土曜日です。", promptVersion: VILLAGE_PROMPT_VERSION, model: "fake-1" },
      { lang: "fr", state: "ready", name: "[fr] 京都の会" },
    ]);
    const usage = await db.select().from(llmUsage);
    expect(usage).toHaveLength(4);
    expect(usage.every(row => row.purpose === "translate")).toBe(true);
  });

  it("tells the engine that the text is the short plain name or description of a village, and applies the glossary", () => {
    const glossary = [{ term: "町家", candidates: ["machiya"] }];
    const name = buildTranslationPrompt({ text: "町家の集い", from: "ja", to: "en", village: "name", glossary });
    expect(name.system).toContain('the name of a community space (a "village")');
    expect(name.system).toContain("single line");
    expect(name.system).not.toContain("The text is Markdown");
    expect(name.user).toContain("machiya");
    expect(name.user).not.toContain("conversation_context");
    expect(buildTranslationPrompt({ text: "説明", from: "ja", to: "en", village: "description" }).system).toContain("the description of a community space");
    expect(buildTranslationPrompt({ text: "説明", from: "ja", to: "en" }).system).toContain("The text is Markdown");
  });

  it("is registered with the other jobs and runs on the translation lane", async () => {
    expect(Object.keys(jobHandlers)).toContain("translate_village");
    const { TRANSLATION_JOB_KINDS } = await import("~/lib/jobs/translation-config.server");
    expect(TRANSLATION_JOB_KINDS).toContain("translate_village");
  });

  it("does not use a result that is not plain short text, nor an untranslated copy: the row fails and the original is read", async () => {
    const { db } = await world();
    const text = "毎月第一土曜日に京都の町家で集まり、人工知能と社会についてゆっくり語り合います。初めての方も歓迎します。";
    await createVillage(db, "vt_author", { slug: "machiya", kind: "open", name: "町家の集い", description: text });
    const id = (await village(db, "machiya")).id;
    const bad: TranslationEngine = { ...createFakeEngine(), async translate(req) {
      const base = await createFakeEngine().translate(req);
      return req.to === "en" ? { ...base, text: "Machiya\n<script>alert(1)</script>" } : { ...base, text: req.text };
    } };
    await run(db, bad);
    const failed = await rows(db, id);
    expect(failed.map(row => [row.lang, row.state, row.name, row.description])).toEqual([["en", "failed", null, null], ["fr", "failed", null, null]]);
    expect(failed.map(row => row.errorCode)).toEqual(["invalid_output", "invalid_output"]);
    const [shown] = await localizeVillages(db, [{ slug: "machiya", name: "町家の集い", description: text, language: null }], { displayLang: "en", readLangs: [] });
    expect(shown).toMatchObject({ name: "町家の集い", description: text });
    expect(shown.translation).toBeUndefined();
  });

  it("keeps the original name when it is a proper noun that comes back the same, and still translates the description", async () => {
    const { db } = await world();
    const name = "Kyoto Reading Circle for Language Models";
    await createVillage(db, "vt_author", { slug: "klm", kind: "open", name, description: "京都で集まります。毎月第一土曜日です。" });
    const id = (await village(db, "klm")).id;
    const sameName: TranslationEngine = { ...createFakeEngine(), async translate(req) {
      const base = await createFakeEngine().translate(req);
      return req.village === "name" ? { ...base, text: req.text } : base;
    } };
    await run(db, sameName);
    const done = await rows(db, id);
    expect(done.map(row => [row.lang, row.state, row.name, row.description])).toEqual([["en", "ready", null, "[en] 京都で集まります。毎月第一土曜日です。"], ["fr", "ready", null, "[fr] 京都で集まります。毎月第一土曜日です。"]]);
    const [shown] = await localizeVillages(db, [{ slug: "klm", name, description: "京都で集まります。毎月第一土曜日です。", language: null }], { displayLang: "en", readLangs: ["en"] });
    expect(shown).toMatchObject({ name, description: "[en] 京都で集まります。毎月第一土曜日です。", translation: { shown: true } });
  });

  it("does not store a name that comes back as the same characters as a translation: there is nothing to translate, the original is read and nothing marks a translation", async () => {
    const { db } = await world();
    const name = "Kyoto Reading Circle for Language Models";
    const sameName: TranslationEngine = { ...createFakeEngine(), async translate(req) {
      const base = await createFakeEngine().translate(req);
      return req.village === "name" ? { ...base, text: req.text } : base;
    } };
    await createVillage(db, "vt_author", { slug: "klm2", kind: "open", name, description: "" });
    const id = (await village(db, "klm2")).id;
    await run(db, sameName);
    expect((await rows(db, id)).map(row => [row.lang, row.state, row.name, row.description, row.errorCode])).toEqual([["en", "failed", null, null, SAME_AS_SOURCE], ["fr", "failed", null, null, SAME_AS_SOURCE]]);
    for (const displayLang of ["en", "fr"] as const) {
      const [shown] = await localizeVillages(db, [{ slug: "klm2", name, description: "", language: null }], { displayLang, readLangs: [] });
      expect(shown).toMatchObject({ name, description: "" });
      expect(shown.translation).toBeUndefined();
    }
    // The name and the description both come back as they are: the same.
    await createVillage(db, "vt_author", { slug: "klm3", kind: "open", name, description: "Reading together, slowly." });
    const copy: TranslationEngine = { ...createFakeEngine(), async translate(req) { return { ...(await createFakeEngine().translate(req)), text: req.text }; } };
    await run(db, copy);
    expect((await rows(db, (await village(db, "klm3")).id)).map(row => [row.state, row.errorCode])).toEqual([["failed", SAME_AS_SOURCE], ["failed", SAME_AS_SOURCE]]);
  });

  it("does not queue a row that has nothing to translate again in the operator's preparation, but translates again when the name, the description or the language changes", async () => {
    const { db } = await world();
    const name = "Kyoto Reading Circle for Language Models";
    const sameName: TranslationEngine = { ...createFakeEngine(), async translate(req) {
      const base = await createFakeEngine().translate(req);
      return req.village === "name" ? { ...base, text: req.text } : base;
    } };
    await createVillage(db, "vt_author", { slug: "klm2", kind: "open", name, description: "" });
    const id = (await village(db, "klm2")).id;
    await run(db, sameName);
    const plan = await planVillageTexts(db);
    expect(plan.pairs).toBe(0);
    expect(await applyVillageTexts(db, plan)).toBe(0);
    expect((await prepareVillages(db)).translations).toBe(0);
    expect(await requestVillageTranslations(db, id, { retryFailed: true })).toBe(0);
    // A description is added: the texts changed, the rows are made again.
    await editVillage(db, "vt_author", "klm2", { name, description: "京都で集まります。" });
    expect((await rows(db, id)).map(row => row.state)).toEqual(["pending", "pending"]);
    await run(db, sameName);
    expect((await rows(db, id)).map(row => [row.state, row.name, row.description])).toEqual([["ready", null, "[en] 京都で集まります。"], ["ready", null, "[fr] 京都で集まります。"]]);
    // The language of the texts changes.
    await editVillage(db, "vt_author", "klm2", { name, description: "京都で集まります。", sourceLang: "en" });
    expect((await rows(db, id)).map(row => [row.lang, row.state])).toEqual([["fr", "pending"], ["ja", "pending"]]);
  });

  it("decides the language of a village without one as the preparation would, whoever edits it first", async () => {
    const { db } = await world();
    await db.update(villages).set({ sourceLang: null }).where(eq(villages.slug, "kyoto"));
    await changeVillageMembership(db, "vt_reader", "kyoto", "join");
    await db.update(villageMembers).set({ role: "owner" }).where(eq(villageMembers.userId, "vt_reader"));
    const v = await village(db, "kyoto");
    expect(await decideVillageLangOf(db, v)).toEqual({ lang: "ja", by: "author" });
    expect(await editVillage(db, "vt_reader", "kyoto", { name: "京都の新しい会", description: v.description })).toMatchObject({ ok: true });
    expect((await village(db, "kyoto")).sourceLang).toBe("ja");
  });

  it("drops a result for texts that were edited while it ran", async () => {
    const { db, id } = await world();
    const racing: TranslationEngine = { ...createFakeEngine(), async translate(req) {
      await editVillage(db, "vt_author", "kyoto", { name: "京都の新しい会", description: "新しい説明" });
      return createFakeEngine().translate(req);
    } };
    await runDueJobs(db, createVillageTranslationHandlers({ llm: { engines: engines(racing) } }), { now: t0, logger: quietLogger, limit: 1 });
    expect((await rows(db, id)).every(row => row.state === "pending" && row.name === null)).toBe(true);
    await run(db);
    expect((await rows(db, id)).map(row => [row.state, row.name])).toEqual([["ready", "[en] 京都の新しい会"], ["ready", "[fr] 京都の新しい会"]]);
  });

  it("validates a translated name and description", () => {
    expect(translatedVillageName("Kyoto circle", "京都の会")).toBe("Kyoto circle");
    expect(translatedVillageName("Kyoto\ncircle", "京都の会")).toBeNull();
    expect(translatedVillageName("<b>Kyoto</b>", "京都の会")).toBeNull();
    expect(translatedVillageName("x".repeat(241), "京都の会")).toBeNull();
    expect(translatedVillageName("<b>Kyoto</b>", "<b>京都</b>")).toBe("<b>Kyoto</b>");
    expect(translatedVillageDescription("Line one.\nLine two.", "一行目。\n二行目。")).toBe("Line one.\nLine two.");
    expect(translatedVillageDescription("```code```", "説明")).toBeNull();
    expect(translatedVillageDescription("[a](https://example.com)", "説明")).toBeNull();
  });
});

describe("what a reader sees", () => {
  it("shows the translation to a reader of another language, the original to the others, and the original while it is not ready or has been edited", async () => {
    const { db } = await world();
    const row = { slug: "kyoto", name: "京都の会", description: "京都で集まります。\n毎月第一土曜日です。", language: null };
    const en = { displayLang: "en", readLangs: ["en"] } as const;
    expect((await localizeVillage(db, row, en)).translation).toBeUndefined();
    await run(db);
    expect(await localizeVillage(db, row, en)).toMatchObject({ name: "[en] 京都の会", description: "[en] 京都で集まります。\n毎月第一土曜日です。", translation: { from: "ja", shown: true, originalName: "京都の会", originalDescription: row.description } });
    // The reader asked for the original: the row keeps it, and says that a translation exists.
    expect(await localizeVillage(db, row, en, { original: true })).toMatchObject({ name: "京都の会", translation: { shown: false } });
    // The display language is the original language, or the reader reads it in the original: no translation.
    expect((await localizeVillage(db, row, { displayLang: "ja", readLangs: [] })).translation).toBeUndefined();
    expect((await localizeVillage(db, row, { displayLang: "en", readLangs: ["ja"] })).translation).toBeUndefined();
    expect((await localizeVillage(db, row, null)).translation).toBeUndefined();
    // An edit hides the old translation at once, before any new one exists.
    await editVillage(db, "vt_author", "kyoto", { name: "京都の集い", description: row.description });
    expect((await localizeVillage(db, { ...row, name: "京都の集い" }, en)).translation).toBeUndefined();
    // A language village's name is not translated; the label of the screen makes it.
    const [english] = await localizeVillages(db, [{ slug: "en", name: "", description: "", language: "en" }], { displayLang: "ja", readLangs: [] });
    expect(english).toMatchObject({ name: "" });
  });

  it("is used by the directory, the joined list and the posting choices", async () => {
    const { db } = await world();
    await run(db);
    const reader = { displayLang: "en", readLangs: ["en"] } as const;
    const directory = await localizeVillages(db, await listVillages(db, "vt_reader"), reader);
    expect(directory.find(v => v.slug === "kyoto")).toMatchObject({ name: "[en] 京都の会" });
    const posting = await postingVillages(db, "vt_author", undefined, { reader: { displayLang: "fr", readLangs: [] } });
    expect(posting.choices.map(choice => choice.slug)).toContain("ja");
    expect((await listJoinedVillages(db, "vt_author")).map(v => v.slug)).toContain("kyoto");
  });

  it("adds the machine translation beside the original in the Markdown list when a language is asked for", async () => {
    const { db } = await world();
    await run(db);
    const plain = await buildListMarkdown(db, null, { kind: "villages" }, { page: 1, lang: null, k: null });
    expect(plain).not.toContain("name_translation");
    // The language the name and description are written in is given whether or not a translation is asked for.
    expect(plain).toMatch(/lang: "?ja"?/);
    const withLang = await buildListMarkdown(db, null, { kind: "villages" }, { page: 1, lang: "en", k: null });
    expect(withLang).toContain("京都の会");
    expect(withLang).toContain("name_translation");
    expect(withLang).toContain("[en] 京都の会");
    expect(withLang).toContain("description_translation");
    const head = await buildListMarkdown(db, null, { kind: "village", slug: "kyoto", villageId: (await village(db, "kyoto")).id }, { page: 1, lang: null, k: null });
    expect(head).toMatch(/village_lang: "?ja"?/);
    expect(head).not.toContain("village_name_translation");
  });
});

describe("names in navigation and notifications", () => {
  it("puts the translated name in the places list, with the original for a tooltip, and in the notification of an invitation", async () => {
    const { db } = await world();
    await createVillage(db, "vt_author", { slug: "salon", kind: "invite_public", name: "サロン", description: "招待で入る場です。" });
    expect(await inviteToVillage(db, "vt_author", "salon", "vt_reader", "join")).toMatchObject({ ok: true });
    await changeVillageMembership(db, "vt_reader", "kyoto", "join");
    await run(db);
    const reader = { displayLang: "en", readLangs: ["en"] } as const;
    expect(await joinedVillageNavigation(db, "vt_reader", reader)).toContainEqual(expect.objectContaining({ slug: "kyoto", name: "[en] 京都の会", translation: expect.objectContaining({ originalName: "京都の会" }) }));
    expect((await joinedVillageNavigation(db, "vt_reader")).find(v => v.slug === "kyoto")).toMatchObject({ name: "京都の会" });
    const { items } = await listNotifications(db, "vt_reader", { display: reader });
    expect(items.find(item => item.village?.slug === "salon")?.village).toMatchObject({ name: "[en] サロン", originalName: "サロン" });
    expect((await listNotifications(db, "vt_reader", { display: { readLangs: [], displayLang: "ja" } })).items.find(item => item.village?.slug === "salon")?.village).toMatchObject({ name: "サロン", originalName: undefined });
    expect(villageNameLang({ translation: { from: "ja", shown: false, originalName: "a", originalDescription: "" } })).toBe("ja");
    expect(villageNameLang({ translation: { from: "ja", shown: true, originalName: "a", originalDescription: "" } })).toBeUndefined();
    expect(villageReaderOfMember({ uiLocale: "fr", homeArea: "en" })).toEqual({ displayLang: "fr", readLangs: [] });
    expect(villageReaderOfMember({ uiLocale: "ko", homeArea: "other" })).toEqual({ displayLang: "en", readLangs: [] });
  });
});

describe("the operator's preparation", () => {
  it("lists, for each village it would name, the language and how it was decided, so a wrong call is seen before anything is written", async () => {
    vi.stubEnv("VILLAGES", ""); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const db = await createTestDb();
    await addMember(db, "old_author", "old_author", { homeArea: "fr", readLangs: ["fr"] });
    await db.insert(villages).values([
      { slug: "old-club", kind: "open", name: "Le club", description: "Une description.", createdBy: "old_author" },
      { slug: "old-orphan", kind: "open", name: "孤児の会", description: "作った人がいない村です。ひらがなで書いています。" },
      { slug: "old-plain", kind: "open", name: "1234", description: "5678" },
    ]);
    const lines: string[] = [];
    expect(await runPrepareVillages([], { getDb: async () => db, log: line => lines.push(line), error: () => {} })).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(["village old-club: source language fr (from its author)", "village old-orphan: source language ja (from its text)", "village old-plain: source language en (the site's default)"]));
    expect((await db.select().from(villages)).every(row => row.sourceLang === null)).toBe(true);
  });

  it("names the language of old villages (their author's, or the text's own) and queues what is missing; a dry run writes nothing", async () => {
    vi.stubEnv("VILLAGES", ""); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const db = await createTestDb();
    await addMember(db, "old_author", "old_author", { homeArea: "fr", readLangs: ["fr"] });
    await db.insert(villages).values([
      { slug: "old-club", kind: "open", name: "Le club", description: "Une description.", createdBy: "old_author" },
      { slug: "old-orphan", kind: "open", name: "孤児の会", description: "作った人がいない村です。ひらがなで書いています。" },
      { slug: "old-empty", kind: "open", name: "", description: "" },
    ]);
    const plan = await planVillageTexts(db);
    expect(plan.fill.map(row => [row.slug, row.lang])).toEqual(expect.arrayContaining([["old-club", "fr"], ["old-orphan", "ja"]]));
    expect(plan.fill).toHaveLength(2);
    expect(plan.pairs).toBe(4);
    const dry = await prepareVillages(db);
    expect(dry).toMatchObject({ written: false, textLanguages: 2, translations: 4 });
    expect((await db.select().from(villages)).every(row => row.sourceLang === null)).toBe(true);
    expect(await db.select().from(jobs)).toHaveLength(0);
    const written = await prepareVillages(db, { write: true });
    expect(written).toMatchObject({ written: true });
    expect((await village(db, "old-club")).sourceLang).toBe("fr");
    expect((await village(db, "old-orphan")).sourceLang).toBe("ja");
    expect((await village(db, "old-empty")).sourceLang).toBeNull();
    expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_village"))).toHaveLength(4);
    // Run again: nothing more is queued, and a failed translation is tried again.
    expect(await applyVillageTexts(db, await planVillageTexts(db))).toBe(0);
    await run(db);
    await db.update(villageTranslations).set({ state: "failed" }).where(eq(villageTranslations.lang, "en"));
    expect(await applyVillageTexts(db, await planVillageTexts(db))).toBe(2);
    expect((await prepareVillages(db)).translations).toBe(2);
  }, 60000);
});

describe("the pages", () => {
  let h: RouteHarness;
  beforeAll(async () => {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    h = await setupRouteHarness();
    await ensureLanguageVillages(h.db);
    await h.signIn("vtp_author", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("vtp_reader", { homeArea: "en", readLangs: ["en"] });
    await createVillage(h.db, h.ids.vtp_author, { slug: "nara", kind: "open", name: "奈良の会", description: "奈良で集まります。" });
    await run(h.db);
  });
  afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

  it("opens a village page in the reader's language, with the original one press away, and the owner's form holding the original", async () => {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const slug = { slug: "nara" };
    const english = await villageLoader(h.args(h.request("/v/nara", { as: "vtp_reader" }), slug)) as { village: { name: string; description: string; translation?: { shown: boolean; from: string } }; source: { name: string; lang: string | null } };
    expect(english.village).toMatchObject({ name: "[en] 奈良の会", description: "[en] 奈良で集まります。", translation: { shown: true, from: "ja" } });
    const original = await villageLoader(h.args(h.request("/v/nara?vorig=1", { as: "vtp_reader" }), slug)) as typeof english;
    expect(original.village).toMatchObject({ name: "奈良の会", translation: { shown: false } });
    // ?lang= picks the language for the page, as for posts: asking for the original language shows no translation.
    const japanese = await villageLoader(h.args(h.request("/v/nara?lang=ja", { as: "vtp_reader" }), slug)) as typeof english;
    expect(japanese.village.translation).toBeUndefined();
    const author = await villageLoader(h.args(h.request("/v/nara", { as: "vtp_author" }), slug)) as typeof english;
    expect(author.village.translation).toBeUndefined();
    expect(english.source).toMatchObject({ name: "奈良の会", lang: "ja" });
  });

  it("lists villages in the reader's language, for a signed-out reader by ?lang= too", async () => {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en,fr"); vi.stubEnv("PUBLIC_READING", "1");
    const list = await villagesLoader(h.args(h.request("/villages", { as: "vtp_reader" }))) as { villages: Array<{ slug: string; name: string }> };
    expect(list.villages.find(v => v.slug === "nara")?.name).toBe("[en] 奈良の会");
    const french = await villagesLoader(h.args(h.request("/villages?lang=fr"))) as { villages: Array<{ slug: string; name: string }> };
    expect(french.villages.find(v => v.slug === "nara")?.name).toBe("[fr] 奈良の会");
  });

  it("limits the edits of a village like those of a post: over the limit it answers 429, changes nothing and queues no translation", async () => {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const { action } = await import("~/routes/village");
    const edit = () => h.outcome(() => action(h.args(h.request("/v/nara", { as: "vtp_author", form: { intent: "edit", name: "奈良の新しい会", description: "奈良で集まります。", sourceLang: "ja" } }), { slug: "nara" })));
    const queued = async () => (await h.db.select().from(jobs).where(eq(jobs.kind, "translate_village"))).length;
    for (let i = 0; i < 60; i++) await hitMemberLimit(h.db, "edit", h.ids.vtp_author);
    const before = await queued();
    expect((await edit()).status).toBe(429);
    expect((await village(h.db, "nara")).name).toBe("奈良の会");
    expect(await queued()).toBe(before);
  });
});
