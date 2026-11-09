import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiDraftEdits, drafts, entries, qualityMetricState, translationReports, translations, translationSignalCounts } from "~/lib/db/schema";
import { createDraft, publishDraft, updateDraft } from "~/lib/drafts.server";
import { createTopic, editEntry } from "~/lib/entries.server";
import { draftChangeSpan, recordTranslationGeneration, translationQualitySignals } from "~/lib/eval/signals.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT } from "~/lib/llm/flags";
import { enqueueTranslations } from "~/lib/translations.server";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { createTranslationReport, dismissReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { addMember, createTestDb } from "./helpers/db";
import { quietLogger } from "./helpers/logger";

afterEach(() => vi.unstubAllEnvs());

describe("aggregate translation quality signals", () => {
  it("counts committed primary translations and records a report's source language", async () => {
    const db = await createTestDb();
    await addMember(db, "author", "author");
    await addMember(db, "reader", "reader", { readLangs: ["en"] });
    const topic = await createTopic(db, "author", { lang: "ja", title: "題", body: "本文です。" });
    if (!topic.ok) throw new Error(topic.error);
    const handlers = createTranslationHandlers({ llm: { env: { TRANSLATION_PRIMARY: "fake" } } });
    const options = { now: new Date(Date.now() + 60_000), limit: 300, logger: quietLogger };
    expect((await runDueJobs(db, { translate_title: handlers.translate_title }, options)).failed).toBe(0);
    expect((await db.select().from(translationSignalCounts).where(eq(translationSignalCounts.to, "en")))[0].generated).toBe(1);
    expect((await runDueJobs(db, handlers, options)).failed).toBe(0);
    const [count] = await db.select().from(translationSignalCounts).where(eq(translationSignalCounts.to, "en"));
    expect(count).toMatchObject({ scope: "post", from: "ja" });
    expect(count.generated).toBe(2);
    const report = await createTranslationReport(db, "reader", { entryId: topic.id, lang: "en", field: "body" });
    expect(report.ok).toBe(true);
    expect((await db.select().from(translationReports))[0].sourceLang).toBe("ja");
  });

  it("counts new source and mention revisions but not repeated processing of the same revision", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    const topic = await createTopic(db, "writer", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error(topic.error);
    const handlers = createTranslationHandlers({ llm: { env: { TRANSLATION_PRIMARY: "fake" } } });
    const run = () => runDueJobs(db, handlers, { now: new Date(Date.now() + 60_000), limit: 100, logger: quietLogger });
    const count = async () => (await db.select().from(translationSignalCounts))[0].generated;
    await run(); expect(await count()).toBe(2);
    expect(await editEntry(db, "writer", topic.id, { title: "新しい題", body: "新しい本文。" })).toMatchObject({ ok: true });
    await run(); expect(await count()).toBe(4);
    await db.update(entries).set({ mentionRevision: sql`${entries.mentionRevision} + 1` }).where(eq(entries.id, topic.id));
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await enqueueTranslations(db, { id: topic.id, lang: "ja", sourceHash: source.sourceHash! });
    await run(); expect(await count()).toBe(6);
    await enqueueTranslations(db, { id: topic.id, lang: "ja", sourceHash: source.sourceHash! });
    await run(); expect(await count()).toBe(6);
  });

  it.each([FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT])("excludes %s output and redoing it from generation counts", async flag => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    const topic = await createTopic(db, "writer", { lang: "ja", body: "これは翻訳されるべき日本語の原文です。内容をそのまま写すのではなく、別の言語に訳す必要があります。" });
    if (!topic.ok) throw new Error(topic.error);
    const fake = createFakeEngine();
    const copying = { ...fake, id: flag === FLAG_UNTRANSLATED ? "fake" as const : "gemini" as const, async translate(req: Parameters<typeof fake.translate>[0]) {
      return { ...await fake.translate(req), text: flag === FLAG_UNTRANSLATED ? req.text : `[en] ${req.text}` };
    } };
    const options = { now: new Date(Date.now() + 60_000), limit: 100, logger: quietLogger };
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: copying, secondary: null, judge: null }, env: {} } }), options);
    expect((await db.select().from(translations))[0].flags).toContain(flag);
    expect(await db.select().from(translationSignalCounts)).toHaveLength(0);
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await enqueue(db, "translate_entry", { entryId: topic.id, lang: "en", sourceHash: source.sourceHash, redoFlagged: true });
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: fake, secondary: null, judge: null }, env: {} } }), options);
    expect((await db.select().from(translations))[0].flags).toEqual([]);
    expect(await db.select().from(translationSignalCounts)).toHaveLength(0);
  });

  it("counts report retries separately for the title and body fields", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    await addMember(db, "reader", "reader", { readLangs: ["en"] });
    const topic = await createTopic(db, "writer", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error(topic.error);
    const engines = { primary: createFakeEngine(), secondary: null, judge: null, retry: createFakeEngine({ model: "fake-retry" }) };
    const llm = { engines, env: {} };
    const handlers = createTranslationHandlers({ llm });
    const run = () => runDueJobs(db, handlers, { now: new Date(Date.now() + 60_000), limit: 100, logger: quietLogger });
    await run();
    expect((await db.select().from(translationSignalCounts))[0].generated).toBe(2);
    for (const field of ["title", "body"]) expect(await createTranslationReport(db, "reader", { entryId: topic.id, lang: "en", field }, { llm })).toMatchObject({ route: "retry" });
    await run();
    expect((await db.select().from(translationSignalCounts))[0].generated).toBe(4);
    expect((await db.select().from(translationReports)).every(r => r.correctedAt !== null)).toBe(true);
  });

  it("separates actual corrections from dismissals, excludes old reports, and returns pair-level data only", async () => {
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    await addMember(db, "operator", "quality_reviewer");
    const topic = await createTopic(db, "writer", { lang: "ja", body: "公開の本文。" });
    if (!topic.ok) throw new Error(topic.error);
    const start = new Date("2026-01-01T00:00:00Z");
    await db.update(qualityMetricState).set({ startedAt: start });
    await Promise.all(Array.from({ length: 4 }, () => recordTranslationGeneration(db, "post", "ja", "en")));
    const [corrected, dismissed] = await db.insert(translationReports).values([
      { entryId: topic.id, lang: "en", sourceLang: "ja", field: "body", createdAt: start },
      { entryId: topic.id, lang: "en", sourceLang: "ja", field: "title", createdAt: start },
      { entryId: topic.id, lang: "en", sourceLang: "ja", field: "body", createdAt: new Date("2025-12-31") },
    ]).returning();
    expect(await resolveReportWithHumanTranslation(db, "operator", corrected.id, "A corrected translation.", { now: new Date("2026-01-03") })).toMatchObject({ ok: true });
    expect(await dismissReport(db, "operator", dismissed.id, { now: new Date("2026-01-04") })).toBe(true);
    const signals = await translationQualitySignals(db);
    expect(signals.translations).toEqual([{ scope: "post", from: "ja", to: "en", generated: 4, reports: 2, corrected: 1, medianDays: 2, reportRate: 0.5, correctionRate: 0.5 }]);
    expect(JSON.stringify(signals)).not.toMatch(/writer|operator|reporterId|authorId|entryId|公開/);
  });

  it("records API and MCP edits on successful publication, including unchanged drafts; failures roll back", async () => {
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    const api = await createDraft(db, "writer", { kind: "topic", lang: "ja", title: "AI title", body: "Original AI body." }, { via: "api" });
    if (!api.ok) throw new Error(api.error);
    await updateDraft(db, "writer", api.id, { lang: "ja", title: "AI title", body: "Original AI body. Added." });
    expect(await publishDraft(db, "writer", api.id)).toMatchObject({ ok: true });
    expect(await publishDraft(db, "writer", api.id)).toMatchObject({ ok: false });

    const client = { key: "oauth:test-client", id: "test-client", name: "Test client", uri: null, tokenId: null };
    const mcp = await createClientDraft(db, "writer", client, { kind: "topic", lang: "ja", body: "First AI body." });
    if (!mcp.ok) throw new Error(mcp.error);
    await updateClientDraft(db, "writer", client, mcp.id, { body: "Second AI body." });
    expect(await publishDraft(db, "writer", mcp.id)).toMatchObject({ ok: true });
    const invalid = await createDraft(db, "writer", { kind: "topic", lang: "ja", body: "" }, { via: "api" });
    if (!invalid.ok) throw new Error(invalid.error);
    expect(await publishDraft(db, "writer", invalid.id)).toMatchObject({ ok: false });
    expect(await db.select().from(drafts)).toHaveLength(1);
    expect(await db.select().from(aiDraftEdits)).toHaveLength(2);
    const signals = await translationQualitySignals(db);
    expect(signals.drafts.find(d => d.source === "api")).toMatchObject({ published: 1, changed: 1 });
    expect(signals.drafts.find(d => d.source === "mcp")).toMatchObject({ published: 1, changed: 0, spanRate: 0 });
    expect(JSON.stringify(signals)).not.toMatch(/writer|AI body|entryId|authorId|client/);
    const [sample] = await db.select().from(aiDraftEdits);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, sample.entryId));
    expect((await translationQualitySignals(db)).drafts.reduce((n, d) => n + d.published, 0)).toBe(1);
  });

  it("does not count saving an unchanged human translation as a correction", async () => {
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    await addMember(db, "reviewer", "quality_reviewer");
    const topic = await createTopic(db, "writer", { lang: "ja", body: "本文。" });
    if (!topic.ok) throw new Error(topic.error);
    const [entry] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await db.insert(translations).values({ entryId: topic.id, field: "body", lang: "en", kind: "primary", text: "Same text.", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision, engine: "fake", model: "fake-1" });
    const [report] = await db.insert(translationReports).values({ entryId: topic.id, field: "body", lang: "en", sourceLang: "ja" }).returning();
    expect(await resolveReportWithHumanTranslation(db, "reviewer", report.id, "Same text.")).toMatchObject({ ok: true });
    expect((await db.select().from(translationReports))[0]).toMatchObject({ status: "resolved", correctedAt: null });
  });

  it("keeps a browser edit in untouched fields when the MCP client changes only the title", async () => {
    const db = await createTestDb();
    await addMember(db, "writer", "writer");
    const client = { key: "oauth:c", id: "c", name: "Client", uri: null, tokenId: null };
    const created = await createClientDraft(db, "writer", client, { kind: "topic", lang: "ja", body: "AI body" });
    if (!created.ok) throw new Error(created.error);
    await updateDraft(db, "writer", created.id, { lang: "ja", body: "Human body" });
    await updateClientDraft(db, "writer", client, created.id, { title: "AI title" });
    const [draft] = await db.select().from(drafts);
    expect(draft.aiBaseline).toEqual({ title: "AI title", body: "AI body" });
    expect(draft.body).toBe("Human body");
  });

  it("measures Unicode characters and reports the changed span as an upper bound", () => {
    expect(draftChangeSpan("a😀b", "a😀b")).toMatchObject({ changed: false, beforeChars: 3, changedChars: 0 });
    expect(draftChangeSpan("abc", "abXc")).toMatchObject({ beforeChars: 3, afterChars: 4, changedChars: 1 });
    expect(draftChangeSpan("abcde", "aXcYe").changedChars).toBe(3);
    expect(draftChangeSpan(null, null)).toMatchObject({ changed: false, beforeChars: 0, afterChars: 0, changedChars: 0 });
    expect(draftChangeSpan(null, "題😀")).toMatchObject({ changed: true, beforeChars: 0, afterChars: 2, changedChars: 2 });
    expect(draftChangeSpan("題😀", null)).toMatchObject({ changed: true, beforeChars: 2, afterChars: 0, changedChars: 2 });
  });
});
