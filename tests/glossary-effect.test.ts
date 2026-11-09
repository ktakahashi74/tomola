import { quietLogger as quiet } from "./helpers/logger";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { glossaryEntries, jobs, translations } from "~/lib/db/schema";
import { createTopic, editEntry } from "~/lib/entries.server";
import { expandGlossaryFile, importGlossaryRows, parseGlossaryFile } from "~/lib/glossary-io.server";
import { createGlossaryEntry, deleteGlossaryEntry, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { LlmOptions } from "~/lib/llm/index.server";
import type { TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { getGlossaryVersion } from "~/lib/translations.server";
import { addMember, createTestDb } from "./helpers/db";

// Glossary edits affect only subsequent translations and report-triggered retranslations. Edits queue no translation jobs and leave existing translations untouched.
// One test creates a topic and runs translation jobs for nine languages, which can exceed the default five seconds under load.
vi.setConfig({ testTimeout: 30_000 });

const t = (n: number) => new Date(Date.UTC(2026, 9, 5, n));
const op: GlossaryActor = { userId: "op", scope: { operator: true, langs: [] } };


// Fake engine recording translation requests.
function recording(seen: TranslationRequest[], model = "fake"): TranslationEngine {
  const base = createFakeEngine({ model });
  return { id: "fake", model, translate: async (req) => (seen.push(req), base.translate(req)) };
}
const llmWith = (primary: TranslationEngine, retry: TranslationEngine | null = null): LlmOptions => ({ engines: { primary, secondary: null, judge: null, retry } satisfies EngineSet, env: {} });
const runJobs = (db: Db, llm: LlmOptions, now: Date) => runDueJobs(db, createTranslationHandlers({ llm }), { now, logger: quiet, limit: 500 });

async function setup() {
  const db = await createTestDb();
  await addMember(db, "op", "opal");
  await addMember(db, "u1", "hana");
  await addMember(db, "u2", "somchai", { readLangs: ["th"] });
  const made = await createGlossaryEntry(db, op, { term: "整合性", lang: "ja", targetLang: "th", candidates: "ความสอดคล้อง" }, { now: t(0) });
  if (!made.ok) throw new Error("glossary failed");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "整合性の題", body: "整合性の話です。" });
  if (!topic.ok) throw new Error("topic failed");
  const seen: TranslationRequest[] = [];
  await runJobs(db, llmWith(recording(seen)), t(1));
  return { db, glossaryId: made.id, topicId: topic.id, seen };
}

const snapshot = async (db: Db) => ({
  jobs: JSON.stringify(await db.select().from(jobs).orderBy(asc(jobs.id))),
  translations: JSON.stringify(await db.select().from(translations).orderBy(asc(translations.id))),
});
const thaiHint = (seen: TranslationRequest[], text: string) => seen.find((r) => r.to === "th" && r.text.includes(text))?.glossary;

describe("a change to the glossary does not enqueue a job and does not touch the translations that exist", () => {
  it("add, change, delete, re-add and import leave the jobs table and every translation row (text, glossary version, flags) as they were", async () => {
    const { db, glossaryId } = await setup();
    const before = await snapshot(db);
    const queued = (await db.select().from(jobs).where(eq(jobs.status, "queued"))).length;
    const oldVersion = await getGlossaryVersion(db);

    expect(await createGlossaryEntry(db, op, { term: "新しい語", lang: "ja", targetLang: "th", candidates: "คำใหม่" }, { now: t(2) })).toMatchObject({ ok: true });
    expect(await updateGlossaryEntry(db, op, glossaryId, { term: "整合性", candidates: "การจัดแนว" }, { now: t(3) })).toEqual({ ok: true, changed: true });
    expect(await deleteGlossaryEntry(db, op, glossaryId, { now: t(4) })).toEqual({ ok: true });
    expect(await createGlossaryEntry(db, op, { term: "整合性", lang: "ja", targetLang: "th", candidates: "ความสอดคล้อง" }, { now: t(5) })).toMatchObject({ ok: true, revived: true });
    const parsed = parseGlossaryFile(`format: tomola-glossary\nversion: 1\nentries:\n  - terms: {ja: ["整合性"], en: ["alignment"], th: ["การจัดแนว"]}\n`);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await importGlossaryRows(db, expandGlossaryFile(parsed.file).rows, { actor: op, update: true, now: t(6) });

    expect(await snapshot(db)).toEqual(before);
    // The glossary version changes for future translations, but versions recorded on existing translations stay unchanged.
    expect(await getGlossaryVersion(db)).not.toBe(oldVersion);
    const rows = await db.select().from(translations);
    expect(rows.length).toBeGreaterThan(0);
    // Only translations in the direction with glossary rows (Japanese to Thai) have a glossary version.
    expect(rows.every((r) => r.glossaryVersion === (r.lang === "th" ? oldVersion : null))).toBe(true);
    // No non-translation jobs are queued either.
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.status, "queued"))).toEqual([{ n: queued }]);
  });
});

describe("the new content works from the next translation on", () => {
  it("a post made after the change gets the new candidates in the prompt and the new glossary version on its translation; the post made before keeps its translation", async () => {
    const { db, glossaryId, topicId } = await setup();
    const oldVersion = await getGlossaryVersion(db);
    await updateGlossaryEntry(db, op, glossaryId, { term: "整合性", candidates: "การจัดแนว\nความสอดคล้อง" }, { now: t(2) });
    const newVersion = await getGlossaryVersion(db);
    expect(newVersion).not.toBe(oldVersion);

    const seen: TranslationRequest[] = [];
    const later = await createTopic(db, "u1", { lang: "ja", title: "もう一つの題", body: "整合性についてもう一つ。" });
    if (!later.ok) throw new Error("topic failed");
    await runJobs(db, llmWith(recording(seen)), t(3));
    expect(thaiHint(seen, "整合性についてもう一つ")).toEqual([{ term: "整合性", candidates: ["การจัดแนว", "ความสอดคล้อง"] }]);
    const fresh = await db.select().from(translations).where(and(eq(translations.entryId, later.id), eq(translations.lang, "th")));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.glossaryVersion === newVersion)).toBe(true);
    const old = await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th")));
    expect(old.every((r) => r.glossaryVersion === oldVersion)).toBe(true);

    // Deleted entries are excluded from the prompt and version.
    await deleteGlossaryEntry(db, op, glossaryId, { now: t(4) });
    const third = await createTopic(db, "u1", { lang: "ja", title: "三つ目", body: "整合性、三つ目。" });
    if (!third.ok) throw new Error("topic failed");
    const afterDelete: TranslationRequest[] = [];
    await runJobs(db, llmWith(recording(afterDelete)), t(5));
    expect(thaiHint(afterDelete, "整合性、三つ目")).toEqual([]);
    expect((await db.select().from(translations).where(and(eq(translations.entryId, third.id), eq(translations.lang, "th"))))[0].glossaryVersion).toBeNull();
  });

  it("the re-translation after an edit of the original uses the glossary of that time", async () => {
    const { db, glossaryId, topicId } = await setup();
    await updateGlossaryEntry(db, op, glossaryId, { term: "整合性", candidates: "การจัดแนว" }, { now: t(2) });
    const edited = await editEntry(db, "u1", topicId, { title: "整合性の題", body: "整合性の話です。書き足しました。" }, { kind: "topic", now: t(3) });
    expect(edited).toMatchObject({ ok: true, changed: true });
    const seen: TranslationRequest[] = [];
    await runJobs(db, llmWith(recording(seen)), t(4));
    expect(thaiHint(seen, "書き足しました")).toEqual([{ term: "整合性", candidates: ["การจัดแนว"] }]);
    const version = await getGlossaryVersion(db);
    expect((await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body"), eq(translations.kind, "primary"))))[0].glossaryVersion).toBe(version);
  });

  it("the automatic re-translation after a report (role retry) uses the glossary of that time, and records its version", async () => {
    const { db, glossaryId, topicId } = await setup();
    await updateGlossaryEntry(db, op, glossaryId, { term: "整合性", candidates: "การจัดแนว" }, { now: t(2) });
    const version = await getGlossaryVersion(db);
    const seen: TranslationRequest[] = [];
    const llm = llmWith(createFakeEngine(), recording(seen, "fake-retry"));
    const reported = await createTranslationReport(db, "u2", { entryId: topicId, lang: "th" }, { now: t(3), llm });
    expect(reported).toMatchObject({ ok: true, route: "retry" });
    await runJobs(db, llm, t(4));
    // Both body and title retry requests use the current glossary entries.
    const retried = seen.filter((r) => r.to === "th");
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.every((r) => JSON.stringify(r.glossary) === JSON.stringify([{ term: "整合性", candidates: ["การจัดแนว"] }]))).toBe(true);
    const body = (await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body"), eq(translations.kind, "primary"))))[0];
    expect(body).toMatchObject({ model: "fake-retry", glossaryVersion: version });
  });
});

describe("the glossary table is read for translation by the one function that leaves deleted entries out", () => {
  it("keeps the deleted row (and its history) while the translation no longer sees it", async () => {
    const { db, glossaryId } = await setup();
    await deleteGlossaryEntry(db, op, glossaryId, { now: t(2) });
    expect((await db.select().from(glossaryEntries)).map((r) => r.deletedAt !== null)).toEqual([true]);
    expect(await getGlossaryVersion(db)).toBeNull();
  });
});
