import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entries, jobs, llmUsage, translationReports, translationRevisions, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { loadEntryDisplays, loadTitleDisplays } from "~/lib/entry-display.server";
import { createTranslationHandlers, TITLE_CONTEXT_MAX_CHARS } from "~/lib/jobs/translation-jobs.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { MAIL_JOB_KINDS } from "~/lib/jobs/mail-kinds";
import { jobHandlers } from "~/lib/jobs/handlers.server";
import { createNotificationHandlers } from "~/lib/jobs/notification-jobs.server";
import { createPasskeyHandlers } from "~/lib/jobs/passkey-jobs.server";
import { createAccountDeletionHandlers } from "~/lib/jobs/account-delete-jobs.server";
import { FLAG_PROVISIONAL_TITLE, FLAG_RETRIED_AFTER_REPORT, HIDDEN_PRIMARY_FLAGS, REVIEW_FLAGS } from "~/lib/llm/flags";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { LlmError } from "~/lib/llm/errors.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { parseThreadBlocks } from "./helpers/md";
import { loadMdTranslations } from "~/lib/md/translations.server";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { RETRANSLATE_REPORT_JOB } from "~/lib/translations.server";
import type { TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { addMember, createTestDb } from "./helpers/db";

const now = new Date("2030-10-09T00:00:00Z");
const quiet = { error() {}, warn() {} };
afterEach(() => vi.unstubAllEnvs());

async function setup(body = "同じ投稿の本文。", title = "原題") {
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  const res = await createTopic(db, "writer", { lang: "ja", title, body });
  if (!res.ok) throw new Error("topic failed");
  const [entry] = await db.select().from(entries).where(eq(entries.id, res.id));
  await db.delete(jobs).where(sql`${jobs.payload}->>'lang' <> 'en'`);
  return { db, entry, input: { id: entry.id, kind: "topic" as const, lang: "ja" as const, title: entry.title, sourceHash: entry.sourceHash } };
}
const recording = (requests: TranslationRequest[], refine = false): TranslationEngine => {
  const fake = createFakeEngine();
  return { ...fake, async translate(req) {
    requests.push(req);
    const out = await fake.translate(req);
    return { ...out, text: refine && req.titleBodyContext ? `[${req.to}] 確定した題` : out.text };
  } };
};
const handlers = (primary = createFakeEngine(), env: Record<string, string> = {}, secondary: TranslationEngine | null = null) =>
  createTranslationHandlers({ llm: { engines: { primary, secondary, judge: null }, env } });
const runKind = (db: Awaited<ReturnType<typeof createTestDb>>, kind: string, hs = handlers()) =>
  runDueJobs(db, { [kind]: hs[kind] }, { now, limit: 100, logger: quiet });
const titleRow = async (db: Awaited<ReturnType<typeof createTestDb>>, id: number) =>
  (await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.field, "title"), eq(translations.lang, "en"), eq(translations.kind, "primary"))))[0];

describe("title-first translation", () => {
  it("prioritizes every registered mail handler", () => {
    const mailHandlers = { ...createNotificationHandlers(), ...createPasskeyHandlers(), ...createAccountDeletionHandlers() };
    expect([...MAIL_JOB_KINDS].sort()).toEqual(Object.keys(mailHandlers).sort());
    expect(Object.keys(jobHandlers).filter(kind => kind.startsWith("send_")).sort()).toEqual([...MAIL_JOB_KINDS].sort());
  });

  it("prioritizes all mail kinds, then titles, then older body work; preserves due-time and ID order within tiers", async () => {
    const db = await createTestDb();
    const seen: string[] = [];
    const kinds = ["translate_entry", "translate_title", "send_notification_email", "send_digest", "send_passkey_notice"];
    for (const [i, kind] of kinds.entries()) await enqueue(db, kind, {}, { runAt: new Date(now.getTime() - (100 - i) * 1000) });
    await enqueue(db, "translate_title", { later: true }, { runAt: now });
    await enqueue(db, "send_digest", {}, { runAt: new Date(now.getTime() + 1000) });
    await runDueJobs(db, Object.fromEntries(kinds.map(kind => [kind, async (job: { kind: string }) => { seen.push(job.kind); }])), { now, logger: quiet });
    expect(seen).toEqual(["send_notification_email", "send_digest", "send_passkey_notice", "translate_title", "translate_title", "translate_entry"]);
  });

  it("saves a displayable provisional title alone, with usage recorded", async () => {
    const { db, entry, input } = await setup();
    const requests: TranslationRequest[] = [];
    expect(await runKind(db, "translate_title", handlers(recording(requests)))).toMatchObject({ done: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0].titleBodyContext).toBeUndefined();
    expect(await titleRow(db, entry.id)).toMatchObject({ flags: [FLAG_PROVISIONAL_TITLE] });
    expect(HIDDEN_PRIMARY_FLAGS).not.toContain(FLAG_PROVISIONAL_TITLE);
    expect(REVIEW_FLAGS).not.toContain(FLAG_PROVISIONAL_TITLE);
    expect(await db.select().from(llmUsage)).toHaveLength(1);
    const opts = { readLangs: ["en" as const], displayLang: "en" as const };
    expect((await loadTitleDisplays(db, [input], opts)).get(entry.id)).toMatchObject({ text: "[en] 原題", pending: true, kind: "primary" });
    expect((await loadEntryDisplays(db, [input], opts)).get(entry.id)).toEqual({ shown: "original", pending: true, translation: null });
    expect(await loadMdTranslations(db, [input], "en")).toMatchObject({ langs: new Map([[entry.id, []]]), shown: new Map() });
    const md = await buildThreadMarkdown(db, entry.id, { page: 1, lang: "en", sentences: false, k: null });
    const [post] = parseThreadBlocks(md!);
    expect(post.fm).toMatchObject({ title: entry.title, lang: "ja", translations_pending: expect.arrayContaining(["en"]) });
    expect(post.body).toContain(entry.body);
    expect(md).not.toContain("[en] 原題");
    expect((await loadTitleDisplays(db, [input], { ...opts, readLangs: ["ja"] })).get(entry.id)).toMatchObject({ text: "原題", pending: false });
  });

  it.each([false, true])("refines the title using its own bounded body, removing the provisional flag and recording only changed content (change=%s)", async (change) => {
    const body = "自分の文。" + "🌱".repeat(TITLE_CONTEXT_MAX_CHARS + 20);
    const { db, entry, input } = await setup(body);
    await addMember(db, "other", "other");
    expect((await createReply(db, "other", entry.id, { lang: "ja", body: "他の会員だけの文" })).ok).toBe(true);
    const requests: TranslationRequest[] = [];
    const hs = handlers(recording(requests, change));
    await runKind(db, "translate_title", hs);
    requests.length = 0;
    await runDueJobs(db, { translate_entry: hs.translate_entry }, { now, limit: 1, logger: quiet });
    const title = requests.find(r => r.text === entry.title)!;
    const context = JSON.parse(title.titleBodyContext!);
    expect(context.source).toBe(Array.from(body).slice(0, TITLE_CONTEXT_MAX_CHARS).join(""));
    expect(Array.from(context.translation).length).toBeLessThanOrEqual(TITLE_CONTEXT_MAX_CHARS);
    expect(title.titleBodyContext).toContain("[en]");
    expect(title.titleBodyContext).not.toContain("他の会員");
    expect(requests.find(r => r.text === body)?.titleBodyContext).toBeUndefined();
    expect((await titleRow(db, entry.id)).flags).not.toContain(FLAG_PROVISIONAL_TITLE);
    expect(await db.select().from(translationRevisions)).toHaveLength(change ? 1 : 0);
    expect((await loadTitleDisplays(db, [input], { readLangs: ["en"], displayLang: "en" })).get(entry.id)?.pending).toBe(false);
  });

  it.each([
    ["5ドルのプラン", "The $5 plan"],
    ["5ドルと10ドルのプラン", "The $5 and $10 plans"],
  ])("saves raw dollar titles once in provisional, refined and report-retry jobs: %s", async (source, text) => {
    const { db, entry, input } = await setup("同じ投稿の本文。", source);
    const requests: TranslationRequest[] = [];
    const fake = createFakeEngine();
    const engine: TranslationEngine = { ...fake, async translate(req) {
      requests.push(req);
      const out = await fake.translate(req);
      return { ...out, text: req.text === source ? text : out.text };
    } };
    const llm = { engines: { primary: engine, secondary: null, judge: null, retry: engine } };
    const hs = createTranslationHandlers({ llm });
    const shown = () => loadTitleDisplays(db, [input], { readLangs: ["en"], displayLang: "en" });
    const titleCalls = () => requests.filter(req => req.text === source);

    expect(await runKind(db, "translate_title", hs)).toMatchObject({ done: 1 });
    expect(await titleRow(db, entry.id)).toMatchObject({ text, flags: [FLAG_PROVISIONAL_TITLE] });
    expect((await shown()).get(entry.id)).toMatchObject({ text, pending: true });
    expect(titleCalls()).toHaveLength(1);

    expect(await runKind(db, "translate_entry", hs)).toMatchObject({ done: 1 });
    expect(await titleRow(db, entry.id)).toMatchObject({ text, flags: [] });
    expect((await shown()).get(entry.id)).toMatchObject({ text, pending: false });
    expect(titleCalls()).toHaveLength(2);

    await addMember(db, "currency_reader", "currency_reader", { readLangs: ["en"] });
    await db.update(translations).set({ text: "An incorrect plan" }).where(eq(translations.id, (await titleRow(db, entry.id)).id));
    const report = await createTranslationReport(db, "currency_reader", { entryId: entry.id, lang: "en", field: "title" }, { now, llm });
    expect(report).toMatchObject({ ok: true, route: "retry" });
    expect(await runKind(db, RETRANSLATE_REPORT_JOB, hs)).toMatchObject({ done: 1 });
    expect(await titleRow(db, entry.id)).toMatchObject({ text, flags: [FLAG_RETRIED_AFTER_REPORT] });
    expect((await shown()).get(entry.id)).toMatchObject({ text, pending: false });
    expect(await db.select().from(translationReports)).toMatchObject([{ status: "resolved" }]);
    expect(titleCalls()).toHaveLength(3);
    expect(titleCalls().every(req => req.retryNote === undefined)).toBe(true);
    await runKind(db, RETRANSLATE_REPORT_JOB, hs);
    expect(titleCalls()).toHaveLength(3);
  });

  it.each(["link_mismatch", "untranslated"])("keeps a visible provisional title and its provenance when refinement has %s", async flag => {
    const { db, entry, input } = await setup("同じ投稿の本文。", "文脈つきの訳し直しでも一覧から消えてはいけない長い題");
    await runKind(db, "translate_title");
    const before = await titleRow(db, entry.id);
    await db.update(translations).set({ flags: [...before.flags, "untranslated_similar"] }).where(eq(translations.id, before.id));
    const fake = createFakeEngine({ model: "refinement" });
    const requests: TranslationRequest[] = [];
    const engine = { ...fake, async translate(req: TranslationRequest) {
      const out = await fake.translate(req);
      if (!req.titleBodyContext) return out;
      requests.push(req);
      return { ...out, text: flag === "untranslated" ? req.text : "Translated title https://example.com/added-link" };
    } };
    expect(await runKind(db, "translate_entry", handlers(engine))).toMatchObject({ done: 1 });
    expect(requests).toHaveLength(2);
    expect(requests[1].retryNote).toBeTruthy();
    const after = await titleRow(db, entry.id);
    expect(after).toEqual({ ...before, flags: ["untranslated_similar"], updatedAt: after.updatedAt });
    expect(after.flags).not.toContain(flag);
    expect(await db.select().from(translationRevisions)).toEqual([]);
    expect((await loadTitleDisplays(db, [input], { readLangs: ["en"], displayLang: "en" })).get(entry.id)).toMatchObject({ text: before.text, kind: "primary", pending: false });
  });

  it("supplies context when the body job starts without a title translation and leaves a final title unchanged on retry", async () => {
    const { db, entry } = await setup();
    const requests: TranslationRequest[] = [];
    const hs = handlers(recording(requests));
    await runKind(db, "translate_entry", hs);
    expect(requests.find(r => r.text === entry.title)?.titleBodyContext).toContain("[en]");
    requests.length = 0;
    await runKind(db, "translate_title", hs);
    expect(requests).toEqual([]);
    expect((await titleRow(db, entry.id)).flags).not.toContain(FLAG_PROVISIONAL_TITLE);
  });

  it.each(["closed", "stale", "existing"])("does not call the title engine for %s work", async reason => {
    const { db, entry } = await setup();
    if (reason === "closed") vi.stubEnv("ENABLED_LANGS", "ja");
    if (reason === "stale") await db.update(entries).set({ sourceHash: "new-revision" }).where(eq(entries.id, entry.id));
    if (reason === "existing") await db.insert(translations).values({ entryId: entry.id, field: "title", lang: "en", kind: "primary", text: "Existing", sourceHash: entry.sourceHash });
    const requests: TranslationRequest[] = [];
    expect(await runKind(db, "translate_title", handlers(recording(requests)))).toMatchObject({ done: 1 });
    expect(requests).toEqual([]);
  });

  it("waits without consuming an attempt at the budget limit", async () => {
    const { db } = await setup();
    await db.insert(llmUsage).values({ engine: "fake", model: "fake-1", purpose: "translate", costUsdMicro: 1_000_000, createdAt: now });
    expect(await runKind(db, "translate_title", handlers(createFakeEngine(), { LLM_MONTHLY_BUDGET_USD: "1" }))).toMatchObject({ deferred: 1 });
    expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_title")))[0]).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("uses the secondary after refusal and retries transient title errors", async () => {
    const { db, entry } = await setup();
    const fake = createFakeEngine();
    const refusal = { ...fake, async translate() { throw new LlmError("refusal", "declined"); } };
    expect(await runKind(db, "translate_title", handlers(refusal, {}, fake))).toMatchObject({ done: 1 });
    expect(await titleRow(db, entry.id)).toMatchObject({ fallback: true, flags: [FLAG_PROVISIONAL_TITLE] });
    await db.delete(translations);
    await db.update(jobs).set({ status: "queued", runAt: now }).where(eq(jobs.kind, "translate_title"));
    const failure = { ...fake, async translate() { throw new Error("temporary"); } };
    expect(await runKind(db, "translate_title", handlers(failure))).toMatchObject({ retried: 1 });
  });

  it("does not let a delayed provisional save overwrite the finalized title", async () => {
    const { db, entry } = await setup();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const fake = createFakeEngine();
    const engine = { ...fake, async translate(req: TranslationRequest) {
      if (!req.titleBodyContext && req.text === entry.title) { started(); await gate; }
      const out = await fake.translate(req);
      return { ...out, text: req.titleBodyContext ? "Final title" : out.text };
    } };
    const hs = handlers(engine);
    const provisional = runKind(db, "translate_title", hs);
    await ready;
    try { await runKind(db, "translate_entry", hs); } finally { release(); }
    await provisional;
    expect(await titleRow(db, entry.id)).toMatchObject({ text: "Final title", flags: [] });
    expect(await db.select().from(translationRevisions)).toEqual([]);
  });

  it("guards saves after source edits and cancels queued title jobs on deletion", async () => {
    const { db, entry } = await setup();
    const fake = createFakeEngine();
    const engine = { ...fake, async translate(req: TranslationRequest) {
      await editEntry(db, "writer", entry.id, { title: "新しい題", body: entry.body });
      return fake.translate(req);
    } };
    await runDueJobs(db, { translate_title: handlers(engine).translate_title }, { now, limit: 1, logger: quiet });
    expect(await titleRow(db, entry.id)).toBeUndefined();
    await softDeleteEntry(db, entry.id);
    expect(await db.select().from(jobs).where(and(eq(jobs.kind, "translate_title"), eq(jobs.status, "queued")))).toEqual([]);
  });

  it("recovers provisional titles during requeue even if the body already exists", async () => {
    const { db, entry } = await setup();
    await runKind(db, "translate_title");
    await db.insert(translations).values({ entryId: entry.id, field: "body", lang: "en", kind: "primary", text: "Body", sourceHash: entry.sourceHash });
    await db.delete(jobs);
    expect(await requeueTranslations(db, { langs: ["en"] })).toMatchObject({ translate: 1 });
    await runKind(db, "translate_entry");
    expect((await titleRow(db, entry.id)).flags).not.toContain(FLAG_PROVISIONAL_TITLE);
  });

  it("does not queue titles for titleless topics or replies, and leaves titleless lines pending until their body arrives", async () => {
    const { db, entry, input } = await setup("題のない本文。", "");
    expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_title"))).toEqual([]);
    const reply = await createReply(db, "writer", entry.id, { lang: "ja", body: "返信" });
    expect(reply.ok).toBe(true);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_title"))).toEqual([]);
    const opts = { readLangs: ["en" as const], displayLang: "en" as const };
    expect((await loadTitleDisplays(db, [input], opts)).get(entry.id)).toMatchObject({ fromBody: true, pending: true });
    await runKind(db, "translate_entry");
    expect((await loadTitleDisplays(db, [input], opts)).get(entry.id)).toMatchObject({ text: "[en] 題のない本文。", fromBody: true, pending: false });
  });
});
