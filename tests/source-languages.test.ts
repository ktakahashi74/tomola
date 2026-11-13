import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { detectLang, detectSourceLanguage } from "~/lib/lang-detect.core.server";
import { resolvePostLanguage } from "~/lib/lang-detect";
import { entries, entryRevisions, jobs, notifications, reports, translations, readingCounts } from "~/lib/db/schema";
import { createTopic, createReply, editEntry, listTopics } from "~/lib/entries.server";
import { createSourceLanguageHandlers, enqueueSourceLanguageCheck, SOURCE_LANGUAGE_JOB, SOURCE_LANGUAGE_PROMPT_VERSION, recordUntranslatable } from "~/lib/jobs/source-language-jobs.server";
import { m } from "~/paraglide/messages.js";
import { inScope, inLanguageScope, canSeeHidden } from "~/lib/roles.server";
import { effectiveEmailMode } from "~/lib/notifications";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { notificationHrefs } from "~/lib/notification-opening.server";
import { listNotifications } from "~/lib/notifications.server";
import { deleteFinishedJobs } from "~/lib/jobs/maintenance-jobs.server";
import { listReportCards } from "~/lib/moderation.server";
import { canEditGlossary } from "~/lib/glossary.server";
import { countReading } from "~/lib/reading-counts.server";
import { detectCopy } from "~/lib/llm/copy-detection.core.server";
import { translationSystemPrompt } from "~/lib/llm/prompt.server";
import { enabledTargetLangs } from "~/lib/enabled-langs.server";
import { addMember, createTestDb } from "./helpers/db";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";

const greek = "Αυτή είναι μια συζήτηση για τη γλώσσα και την επικοινωνία μεταξύ των ανθρώπων.";
const italian = "Questo è un esempio della nostra lingua e della nostra comunità, con tutti gli amici che sono qui per parlare del nostro lavoro.";
beforeAll(() => setTestMessages(jsonMessages()));
afterAll(() => setTestMessages());
afterEach(() => vi.unstubAllEnvs());

describe("source language evidence", () => {
  it.each([
    [greek, "el"],
    [italian, "it"],
    ["Este es un ejemplo de nuestra comunidad y de los temas que son importantes para todos los que están aquí.", "es"],
    ["Este é um exemplo da nossa comunidade e dos temas que são importantes para todos os que estão aqui.", "pt"],
    ["Սա հայերեն գրված երկար նախադասություն է մեր համայնքի մասին։", "hy"],
    ["ეს არის ქართული ტექსტი ჩვენი საზოგადოების შესახებ.", "ka"],
    ["Это длинный текст о языке и общении между людьми.", null],
    ["هذا نص طويل عن اللغة والتواصل بين الناس في المجتمع.", null],
    ["यह भाषा और लोगों के बीच संचार के बारे में एक लंबा वाक्य है।", null],
  ])("records an unopened source without calling it an enabled language: %s", (text, code) => {
    expect(detectSourceLanguage(text)).toEqual({ lang: "other", langCode: code });
  });
  it("keeps ambiguous prose, quotations, code and short samples inconclusive", () => {
    for (const text of ["ciao", "γεια", "hello world", "> " + greek, "```\n" + greek + "\n```", "bonjour hello ciao hola obrigado"]) expect(detectSourceLanguage(text)).toBeNull();
    expect(detectLang(greek)).toBeNull();
  });
  it("ignores relative image and link destinations, including reference definitions", () => {
    const path = "/media/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd-10x10.webp";
    for (const body of [
      `![own](${path}) ![public](${path}) ![absolute](https://example.org${path})`,
      `[writing](${path}) [picture][asset]\n\n[asset]: ${path} "a e o a e o"`,
      `[writing](${path} "${greek}")`,
    ]) expect(detectSourceLanguage(body)).toBeNull();
    expect(detectSourceLanguage(`[${greek}](${path})`)).toEqual({ lang: "other", langCode: "el" });
  });
  it("allows the bounded fake checker to exercise a confident correction independently of whole-text detection", () => {
    const body = greek.repeat(12) + "\n\n" + "The people are here to discuss the work and to learn from each other. ".repeat(60);
    expect(detectSourceLanguage(body)?.lang).toBe("en");
    expect(detectSourceLanguage(body.slice(0, 1500))).toEqual({ lang: "other", langCode: "el" });
  });
  it("keeps author choices and separates detection from default fallback", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(await resolvePostLanguage(greek, undefined, "en")).toMatchObject({ lang: "other", langCode: "el", langSource: "detected" });
    expect(await resolvePostLanguage(greek, "en", "ja")).toMatchObject({ lang: "en", langCode: null, langSource: "explicit" });
    expect(await resolvePostLanguage(greek, "other", "en")).toMatchObject({ lang: "other", langCode: "el", langSource: "explicit" });
    expect(await resolvePostLanguage("ciao", undefined, "ja")).toMatchObject({ lang: "ja", langSource: "default" });
    expect(await resolvePostLanguage("ciao", "", "ja")).toMatchObject({ lang: "ja", langSource: "default" });
    expect(await resolvePostLanguage("The people are here to discuss the work and to learn from each other.", "other", "ja")).toMatchObject({ lang: "other", langCode: null });
    expect(enabledTargetLangs("other")).toEqual(["ja", "en"]);
    expect(enabledTargetLangs("de")).toEqual(["ja", "en"]);
    expect(translationSystemPrompt("other", "en")).toContain("the language of the source text");
    expect(detectCopy(greek, greek, "other", "en")).toMatchObject({ copy: true, reason: "identical" });
  });
});

async function fixture(langSource: "detected" | "default" | "explicit" | null = "default", code: string | null = "el", confident = true) {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb();
  await addMember(db, "source_writer", "source_writer");
  const created = await createTopic(db, "source_writer", { lang: "en", langSource: langSource ?? "explicit", title: "A language example", body: greek });
  if (!created.ok) throw new Error(created.error);
  if (langSource === null) await db.update(entries).set({ langSource: null }).where(eq(entries.id, created.id));
  const [job] = await db.select().from(jobs).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB));
  const complete = vi.fn(async (req: { user: string }) => {
    expect(JSON.parse(req.user).text.length).toBeLessThanOrEqual(1500);
    return { text: JSON.stringify({ code, confident }), inputTokens: 10, outputTokens: 10 };
  });
  const handlers = createSourceLanguageHandlers({ completer: { engine: "fake", model: "fake-source-language", complete } });
  return { db, id: created.id, job, complete, check: () => handlers[SOURCE_LANGUAGE_JOB](job, { db, now: new Date() }) };
}

it.each(["detected", "default"] as const)("corrects %s without author edit history and queues the former original language", async source => {
  const { db, id, check } = await fixture(source);
  await check(); await check();
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "other", langCode: "el", langSource: "checked" });
  expect(await db.select().from(entryRevisions)).toHaveLength(0);
  expect(await db.select().from(notifications)).toHaveLength(0);
  expect((await db.select().from(jobs)).some(j => j.kind === "translate_entry" && (j.payload as { lang: string }).lang === "en")).toBe(true);
  expect((await db.select().from(jobs)).filter(j => j.kind === SOURCE_LANGUAGE_JOB)).toHaveLength(1);
  const edit = await editEntry(db, "source_writer", id, { lang: "other", title: "A language example", body: greek + " Νέα πρόταση." });
  expect(edit.ok).toBe(true);
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0].langSource).toBe("checked");
});

it.each(["explicit", null] as const)("retains %s choices and creates one in-app-only mismatch notice", async source => {
  const { db, id, check } = await fixture(source);
  await check(); await check();
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "en", langSource: source });
  const notices = await db.select().from(notifications);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ kind: "source_language_mismatch", entryId: id });
  expect(notices[0].emailedAt).not.toBeNull();
  for (const pref of ["auto", "immediate", "daily", "none"] as const) {
    expect(effectiveEmailMode(pref, "source_language_mismatch")).toBe("none");
    expect(effectiveEmailMode(pref, "entry_translation_unavailable")).toBe("none");
  }
});

it("reports only content failures in every target language, leaves the source visible and notifies once", async () => {
  const { db, id } = await fixture();
  await db.update(entries).set({ lang: "other", langCode: "el" }).where(eq(entries.id, id));
  const [entry] = await db.select().from(entries).where(eq(entries.id, id));
  for (const lang of ["ja", "en"]) await db.insert(jobs).values({ kind: "translate_entry", payload: { entryId: id, sourceHash: entry.sourceHash, lang }, status: "failed" });
  const work = (await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).filter(j => j.status === "failed");
  await recordUntranslatable(work[0], { db, now: new Date() }, true);
  expect(await db.select().from(reports)).toHaveLength(0);
  await recordUntranslatable(work[1], { db, now: new Date() }, false);
  expect(await db.select().from(reports)).toHaveLength(0);
  // Remove the original queued translation before settling the synthetic failures.
  await db.delete(jobs).where(and(eq(jobs.kind, "translate_entry"), eq(jobs.status, "queued")));
  await recordUntranslatable(work[1], { db, now: new Date() }, true);
  await recordUntranslatable(work[1], { db, now: new Date() }, true);
  expect(await db.select().from(reports)).toHaveLength(1);
  expect(await db.select().from(notifications)).toHaveLength(1);
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0].hiddenAt).toBeNull();
  const scope = { operator: false, langs: ["ja" as const] };
  expect(inScope(scope, "other")).toBe(true);
  expect(inScope(scope, "de")).toBe(true);
  expect(canSeeHidden({ userId: "reviewer", scope }, { authorId: "source_writer", lang: "other" })).toBe(true);
  expect(inScope(scope, "en")).toBe(false);
  expect(inLanguageScope(scope, "de")).toBe(false);
  expect(inLanguageScope(scope, "other")).toBe(false);
  expect(inLanguageScope(scope, "ja")).toBe(true);
  expect(canEditGlossary(scope, "de")).toBe(false);
  const listed = await listReportCards(db, scope, { viewerId: "source_reviewer" });
  expect(listed.cards).toContainEqual(expect.objectContaining({ entryId: id, lang: "other", hidden: false }));
});

it("rounds unopened source and original-reading languages into anonymous other buckets", async () => {
  const { db, id } = await fixture();
  await db.update(entries).set({ lang: "de" }).where(eq(entries.id, id));
  await countReading(db, id, { method: "browser", lang: "de", source: "none" });
  expect((await db.select().from(readingCounts)).find(row => row.count > 0)).toMatchObject({ sourceLang: "other", readLang: "other" });
});

it("keeps confirmed, inconclusive and obsolete checks from changing the current source", async () => {
  const { db, id, check, complete } = await fixture();
  await check();
  complete.mockClear();
  await check();
  expect(complete).not.toHaveBeenCalled();
  await db.update(entries).set({ langSource: "default", mentionRevision: 2 }).where(eq(entries.id, id));
  await check();
  expect(complete).not.toHaveBeenCalled();
  const unknown = await fixture("default", null, false);
  await unknown.check();
  expect((await unknown.db.select().from(entries).where(eq(entries.id, unknown.id)))[0]).toMatchObject({ lang: "en", langSource: "default" });
  expect(await unknown.db.select().from(notifications)).toHaveLength(0);
});

it("removes the new original-language translation and carries unchanged text to the corrected revision", async () => {
  const { db, id, check } = await fixture("detected", "ja");
  const [before] = await db.select().from(entries).where(eq(entries.id, id));
  for (const lang of ["ja", "en"]) await db.insert(translations).values({ entryId: id, field: "body", lang, kind: "primary", text: `[${lang}] Translation`, sourceHash: before.sourceHash, mentionRevision: before.mentionRevision });
  await check();
  const [after] = await db.select().from(entries).where(eq(entries.id, id));
  expect(after).toMatchObject({ lang: "ja", langCode: null, langSource: "checked", mentionRevision: before.mentionRevision + 1 });
  expect(await db.select().from(translations)).toMatchObject([{ lang: "en", sourceHash: after.sourceHash, mentionRevision: after.mentionRevision }]);
});

it("settles simultaneous final targets before queue status updates and deduplicates the author notice", async () => {
  const { db, id } = await fixture();
  const [entry] = await db.update(entries).set({ lang: "other", langCode: "el" }).where(eq(entries.id, id)).returning();
  await db.delete(jobs).where(eq(jobs.kind, "translate_entry"));
  const work = await db.insert(jobs).values(["ja", "en"].map(lang => ({ kind: "translate_entry", payload: { entryId: id, sourceHash: entry.sourceHash, lang }, status: "running" }))).returning();
  await Promise.all(work.map(job => recordUntranslatable(job, { db, now: new Date() }, true, entry.mentionRevision)));
  expect(await db.select().from(reports)).toHaveLength(1);
  expect(await db.select().from(notifications)).toMatchObject([{ kind: "entry_translation_unavailable" }]);
});

it("exposes the original code in Markdown and gives the author a repair link", async () => {
  const { db, id, check } = await fixture("explicit");
  await check();
  const notices = (await listNotifications(db, "source_writer")).items;
  expect((await notificationHrefs(db, notices)).get(notices[0].id)).toBe(`/t/${id}/edit`);
  await db.update(entries).set({ lang: "other", langCode: "el" }).where(eq(entries.id, id));
  const markdown = await buildThreadMarkdown(db, id, { page: 1, lang: null, k: null, sentences: false });
  expect(markdown).toContain("lang: other");
  expect(markdown).toContain("lang_code: el");
});

it("keeps a requeued target pending even when an earlier attempt has a content-failure receipt", async () => {
  const { db, id } = await fixture();
  const [entry] = await db.update(entries).set({ lang: "other", langCode: "el" }).where(eq(entries.id, id)).returning();
  await db.delete(jobs).where(eq(jobs.kind, "translate_entry"));
  const work = await db.insert(jobs).values(["ja", "en"].map(lang => ({ kind: "translate_entry", payload: { entryId: id, sourceHash: entry.sourceHash, lang, contentFailure: true, settledRevision: entry.mentionRevision, settledAttempt: 1 }, attempts: 1, status: lang === "ja" ? "running" : "queued" }))).returning();
  await recordUntranslatable(work[0], { db, now: new Date() }, true, entry.mentionRevision);
  expect(await db.select().from(reports)).toHaveLength(0);
  expect(await db.select().from(notifications)).toHaveLength(0);
});

it("can resume a check skipped while hidden without repeating a completed language check", async () => {
  const { db, id, job, check } = await fixture("explicit");
  const [entry] = await db.select().from(entries).where(eq(entries.id, id));
  await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
  await enqueueSourceLanguageCheck(db, { id, sourceHash: entry.sourceHash! });
  expect(await db.select().from(jobs).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB))).toHaveLength(2);
  await check();
  await db.update(jobs).set({ status: "done" }).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB));
  await enqueueSourceLanguageCheck(db, { id, sourceHash: entry.sourceHash! });
  expect(await db.select().from(jobs).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB))).toHaveLength(2);
});

it.each([
  [["untranslated"], false, 0],
  [["untranslated", "body_too_complex"], true, 0],
  [["untranslated_similar"], true, 0],
  [["untranslated"], true, 1],
] as const)("classifies final target outputs without confusing technical failures or warnings: %j, completed %s", async (flags, completed, expected) => {
  const { db, id } = await fixture();
  const [entry] = await db.update(entries).set({ lang: "other", langCode: "el" }).where(eq(entries.id, id)).returning();
  await db.delete(jobs).where(eq(jobs.kind, "translate_entry"));
  const work = await db.insert(jobs).values(["ja", "en"].map(lang => ({ kind: "translate_entry", payload: { entryId: id, sourceHash: entry.sourceHash, lang }, status: "running" }))).returning();
  for (const lang of ["ja", "en"]) await db.insert(translations).values({ entryId: id, lang, field: "body", kind: "primary", text: greek, flags: [...flags], sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision });
  for (const job of work) await recordUntranslatable(job, { db, now: new Date() }, false, entry.mentionRevision, completed);
  expect(await db.select().from(reports)).toHaveLength(expected);
  expect(await db.select().from(notifications)).toHaveLength(expected);
});

it("retains the current receipt through job cleanup and expires it after the original changes", async () => {
  const { db, id, job, check } = await fixture("explicit");
  await check();
  await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
  const future = new Date(Date.now() + 31 * 86400_000);
  await deleteFinishedJobs(db, future);
  expect(await db.select().from(jobs).where(eq(jobs.kind, "source_language_receipt"))).toHaveLength(1);
  const [entry] = await db.select().from(entries).where(eq(entries.id, id));
  await enqueueSourceLanguageCheck(db, { id, sourceHash: entry.sourceHash! });
  expect(await db.select().from(jobs).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB))).toHaveLength(0);
  expect(await db.select().from(notifications)).toHaveLength(1);
  expect(await editEntry(db, "source_writer", id, { lang: "en", title: "A language example", body: greek + " Νέα πρόταση." })).toMatchObject({ ok: true });
  await deleteFinishedJobs(db, future);
  expect(await db.select().from(jobs).where(eq(jobs.kind, "source_language_receipt"))).toHaveLength(0);
});

it("keeps unopened originals in all lists and out of a different original-language filter", async () => {
  const { db, id } = await fixture();
  const japanese = await createTopic(db, "source_writer", { lang: "ja", title: "Japanese original", body: "日本語で書かれた話題です。" });
  const italianTopic = await createTopic(db, "source_writer", { lang: "other", langCode: "it", title: "Italian original", body: italian });
  const german = await createTopic(db, "source_writer", { lang: "de", title: "German original", body: "Ein deutscher Beitrag." });
  if (!japanese.ok || !italianTopic.ok || !german.ok) throw new Error("topic failed");
  for (const order of ["created", "activity", "insightful"] as const) {
    expect((await listTopics(db, { kind: "langs", langs: ["ja"] }, { order })).topics.map(t => t.id)).toEqual([japanese.id]);
    expect((await listTopics(db, { kind: "all" }, { order })).topics.map(t => t.id).sort()).toEqual([id, japanese.id, italianTopic.id, german.id].sort());
  }
});

it.each([
  ["zh", "zh-Hans", null, "detected", "zh-Hans", null],
  ["ZH", "zh-Hant", null, "explicit", "zh-Hant", null],
  ["zh", "en", null, "default", "en", null],
  ["zh", "en", null, "explicit", "en", null],
  ["zh-hans", "en", null, "default", "zh-Hans", null],
  ["ZH-hANT", "en", null, "default", "zh-Hant", null],
  ["zh-CN", "en", null, "default", "zh-Hans", null],
  ["zh-TW", "zh-Hant", null, "explicit", "zh-Hant", null],
  ["zh-hans", "zh-Hant", null, "explicit", "zh-Hant", null],
  ["zh-hans", "other", "zh", "explicit", "other", "zh"],
  ["IT-it", "other", "it", "explicit", "other", "it"],
  ["ita", "other", "it", "explicit", "other", "it"],
  ["ita", "en", null, "default", "other", "it"],
  ["zzz", "en", null, "explicit", "en", null],
  ["und", "en", null, "default", "en", null],
  ["mul", "en", null, "explicit", "en", null],
  ["zxx", "en", null, "default", "en", null],
  ["EN-us", "en", null, "explicit", "en", null],
] as const)("normalizes checker code %s against %s/%s (%s) without false notices", async (code, lang, langCode, langSource, expectedLang, expectedCode) => {
  const { db, id, check, complete } = await fixture(langSource, code);
  const [before] = await db.update(entries).set({ lang, langCode }).where(eq(entries.id, id)).returning();
  await check(); await check();
  expect(complete).toHaveBeenCalledTimes(1);
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({
    lang: expectedLang, langCode: expectedCode,
    langSource: expectedLang === lang && expectedCode === langCode ? langSource : "checked",
  });
  expect(await db.select().from(notifications)).toHaveLength(0);
  expect((await db.select().from(jobs)).filter(j => j.kind === "source_language_receipt").some(j =>
    (j.payload as { promptVersion?: string }).promptVersion === SOURCE_LANGUAGE_PROMPT_VERSION)).toBe(true);
  if (expectedLang === lang && expectedCode === langCode) {
    expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ sourceHash: before.sourceHash, mentionRevision: before.mentionRevision });
  }
});

it("settles only requested body targets with reader-based eager translation", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
  vi.stubEnv("TRANSLATION_EAGER_SCOPE", "readers");
  const db = await createTestDb();
  await addMember(db, "eager_source", "eager_source", { readLangs: ["ja"] });
  await addMember(db, "eager_reader", "eager_reader", { readLangs: ["en"] });
  const topic = await createTopic(db, "eager_source", { lang: "other", langCode: "el", title: "Reader-based targets", body: greek });
  if (!topic.ok) throw new Error(topic.error);
  const [entry] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const work = await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"));
  expect(work.map(j => (j.payload as { lang: string }).lang).sort()).toEqual(["en", "ja"]);
  expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_title"))).map(j => (j.payload as { lang: string }).lang).sort()).toEqual(["en", "fr", "ja"]);
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.kind, "translate_entry"));
  await recordUntranslatable(work[0], { db, now: new Date() }, true, entry.mentionRevision);
  expect(await db.select().from(reports)).toHaveLength(0);
  await recordUntranslatable(work[1], { db, now: new Date() }, true, entry.mentionRevision);
  await recordUntranslatable(work[1], { db, now: new Date() }, true, entry.mentionRevision);
  const result = await db.select().from(reports);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ reporterId: null, reason: "other", aiAssessment: {
    en: m.source_translation_unavailable_assessment({}, { locale: "en" }),
    ja: m.source_translation_unavailable_assessment({}, { locale: "ja" }),
  } });
  expect(result[0].aiAssessment?.en).not.toBe("");
  expect(result[0].aiAssessment?.ja).not.toBe(result[0].aiAssessment?.en);
  expect(await db.select().from(notifications)).toMatchObject([{ kind: "entry_translation_unavailable" }]);
  expect((await db.select().from(entries).where(eq(entries.id, topic.id)))[0].hiddenAt).toBeNull();
});

it("does not report requested-target failure when another requested target has a usable translation", async () => {
  const { db, id } = await fixture();
  const [entry] = await db.update(entries).set({ lang: "other", langCode: "el" }).where(eq(entries.id, id)).returning();
  await db.delete(jobs).where(eq(jobs.kind, "translate_entry"));
  const work = await db.insert(jobs).values(["ja", "en"].map(lang => ({ kind: "translate_entry", payload: { entryId: id, sourceHash: entry.sourceHash, lang }, status: "running" }))).returning();
  await db.insert(translations).values({ entryId: id, lang: "en", field: "body", kind: "primary", text: "A usable translation", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision });
  for (const job of work) await recordUntranslatable(job, { db, now: new Date() }, true, entry.mentionRevision);
  expect(await db.select().from(reports)).toHaveLength(0);
  expect(await db.select().from(notifications)).toHaveLength(0);
});

it.each(["detected", "default", "checked", "explicit", null] as const)("preserves %s provenance and known codes on unchanged-language topic and reply edits", async langSource => {
  const { db, id } = await fixture();
  const reply = await createReply(db, "source_writer", id, { lang: "other", langCode: "sw", body: "Brief names only" });
  if (!reply.ok) throw new Error(reply.error);
  for (const [entryId, title] of [[id, "A language example"], [reply.id, undefined]] as const) {
    await db.update(entries).set({ lang: "other", langCode: "sw", langSource }).where(eq(entries.id, entryId));
    expect(await editEntry(db, "source_writer", entryId, { lang: "other", title, body: "A revised name" })).toMatchObject({ ok: true });
    expect((await db.select().from(entries).where(eq(entries.id, entryId)))[0]).toMatchObject({ lang: "other", langCode: "sw", langSource });
    expect(await editEntry(db, "source_writer", entryId, { lang: "other", title, body: "A revised name" })).toMatchObject({ ok: true, changed: false });
    expect((await db.select().from(entries).where(eq(entries.id, entryId)))[0]).toMatchObject({ langCode: "sw", langSource });
    expect(await editEntry(db, "source_writer", entryId, { lang: "ja", title, body: "A revised name" })).toMatchObject({ ok: true });
    expect((await db.select().from(entries).where(eq(entries.id, entryId)))[0]).toMatchObject({ lang: "ja", langCode: null, langSource: "explicit" });
  }
});

it("checks a new body revision while retaining machine-checked provenance and skips its language-only correction", async () => {
  const { db, id, check, complete } = await fixture();
  await check();
  const [corrected] = await db.select().from(entries).where(eq(entries.id, id));
  await enqueueSourceLanguageCheck(db, { id, sourceHash: corrected.sourceHash! });
  expect(await db.select().from(jobs).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB))).toHaveLength(1);
  expect(await editEntry(db, "source_writer", id, { lang: "other", title: "A language example", body: italian })).toMatchObject({ ok: true });
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "other", langCode: "el", langSource: "checked" });
  const work = await db.select().from(jobs).where(eq(jobs.kind, SOURCE_LANGUAGE_JOB)).orderBy(jobs.id);
  expect(work).toHaveLength(2);
  const handler = createSourceLanguageHandlers({ completer: { engine: "fake", model: "fake-source-language", complete: async () => ({ text: '{"code":"ita","confident":true}', inputTokens: 10, outputTokens: 10 }) } });
  await handler[SOURCE_LANGUAGE_JOB](work[1], { db, now: new Date() });
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "other", langCode: "it", langSource: "checked" });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(await db.select().from(notifications)).toHaveLength(0);
});
