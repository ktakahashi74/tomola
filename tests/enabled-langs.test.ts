import { quietLogger as quiet } from "./helpers/logger";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, translationReports, translations } from "~/lib/db/schema";
import { resolveDisplayLang } from "~/lib/display";
import { displayLangFor, langQueryParam } from "~/lib/display-lang.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { mailLocale } from "~/lib/mail/magic-link.server";
import { loadMdTranslations } from "~/lib/md/translations.server";
import { getProfile, type Profile } from "~/lib/profiles.server";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { requeueTranslations, RequeueLangError } from "~/lib/translations-requeue.server";
import { RETRANSLATE_REPORT_JOB } from "~/lib/translations.server";
import { assertEnabledLangsConfigured, assertEnabledLangsReviewed, defaultUiLocale, enabledLangs, enabledTargetLangs, isEnabledLang, type ReviewCounts } from "~/lib/enabled-langs.server";
import { LANGS, parseEnabledLangs, type Lang } from "~/lib/languages";
import { computeReviewCounts, parseReviewCounts } from "~/lib/i18n/review-counts";
import { fingerprint } from "~/lib/i18n/source-hashes";
import { assertStartupConfig } from "~/lib/startup-checks.server";
import { addMember, createTestDb } from "./helpers/db";
import { getMd } from "./helpers/md";
import { setupRouteHarness } from "./helpers/route-harness";

// ENABLED_LANGS: parsing and startup checks. A language with unchecked UI strings cannot be enabled.
afterEach(() => vi.unstubAllEnvs());

describe("parseEnabledLangs", () => {
  const langs = (raw: string | undefined) => {
    const r = parseEnabledLangs(raw);
    if (!r.ok) throw new Error(r.error);
    return r.langs;
  };

  it("treats unset, empty and blank as all nine languages", () => {
    for (const raw of [undefined, "", "   ", "\n"]) expect(langs(raw), JSON.stringify(raw)).toEqual([...LANGS]);
  });

  it("reads the lists the trial uses: ja,en and ja,en,fr,zh-Hans,zh-Hant, or only one script of Chinese", () => {
    expect(langs("ja,en")).toEqual(["ja", "en"]);
    expect(langs("ja,en,fr,zh-Hans,zh-Hant")).toEqual(["ja", "en", "fr", "zh-Hant", "zh-Hans"]);
    expect(langs("ja,en,fr,zh-Hans")).toEqual(["ja", "en", "fr", "zh-Hans"]);
    expect(langs("en")).toEqual(["en"]);
  });

  it("ignores spaces and case, collapses duplicates, skips empty segments, and returns the order of LANGS", () => {
    expect(langs(" EN , ja ")).toEqual(["ja", "en"]);
    expect(langs("zh-hant,ZH-HANS")).toEqual(["zh-Hant", "zh-Hans"]);
    expect(langs("fr,fr,ja,FR")).toEqual(["ja", "fr"]);
    expect(langs("ja,,en,")).toEqual(["ja", "en"]);
    expect(langs("vi,th,ko,zh-Hans,zh-Hant,de,fr,en,ja")).toEqual([...LANGS]);
  });

  it("rejects unknown tags, naming them, and says how Chinese is named", () => {
    const bad = parseEnabledLangs("ja,xx,zh-CN");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("xx, zh-CN");
      expect(bad.error).toContain("zh-Hans");
      expect(bad.error).toContain("zh-Hant");
    }
    expect(parseEnabledLangs("zh").ok).toBe(false);
    expect(parseEnabledLangs("jp").ok).toBe(false);
    // A value that names no language at all
    const none = parseEnabledLangs(",");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain("names no language");
  });
});

describe("enabledLangs and its readers", () => {
  it("reads the environment on every call (all nine when unset)", () => {
    expect(enabledLangs()).toEqual([...LANGS]);
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(enabledLangs()).toEqual(["ja", "en"]);
    expect(isEnabledLang("ja")).toBe(true);
    expect(isEnabledLang("fr")).toBe(false);
    expect(isEnabledLang("other")).toBe(false);
    expect(isEnabledLang(undefined)).toBe(false);
    vi.stubEnv("ENABLED_LANGS", "ja,fr");
    expect(isEnabledLang("fr")).toBe(true);
    expect(isEnabledLang("en")).toBe(false);
  });

  it("throws on a malformed value when called without the startup check", () => {
    vi.stubEnv("ENABLED_LANGS", "ja,klingon");
    expect(() => enabledLangs()).toThrow("klingon");
  });

  it("defaults the interface language to en when en is enabled, otherwise the first enabled language", () => {
    expect(defaultUiLocale({ ENABLED_LANGS: "ja,en" })).toBe("en");
    expect(defaultUiLocale({ ENABLED_LANGS: "ja,fr" })).toBe("ja");
    expect(defaultUiLocale({ ENABLED_LANGS: "zh-Hant,fr" })).toBe("fr");
    expect(defaultUiLocale({})).toBe("en");
  });

  it("translates into the enabled languages minus the original language", () => {
    expect(enabledTargetLangs("en", { ENABLED_LANGS: "ja,en" })).toEqual(["ja"]);
    expect(enabledTargetLangs("de", { ENABLED_LANGS: "ja,en" })).toEqual(["ja", "en"]);
    expect(enabledTargetLangs("ja", { ENABLED_LANGS: "ja,en,fr" })).toEqual(["en", "fr"]);
    expect(enabledTargetLangs("ja", {})).toEqual(LANGS.filter((l) => l !== "ja"));
  });
});

describe("assertEnabledLangsConfigured", () => {
  it("stops a malformed value in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production", undefined]) {
      expect(() => assertEnabledLangsConfigured({ NODE_ENV, ENABLED_LANGS: "ja,xx" }), String(NODE_ENV)).toThrow("unknown language tag");
    }
  });

  it("requires an explicit value in production (unset, empty and blank stop it), and not in development or test", () => {
    for (const ENABLED_LANGS of [undefined, "", "  "]) {
      expect(() => assertEnabledLangsConfigured({ NODE_ENV: "production", ENABLED_LANGS })).toThrow("ENABLED_LANGS is required in production");
      expect(() => assertEnabledLangsConfigured({ ENABLED_LANGS }), "NODE_ENV unset is production").toThrow("ENABLED_LANGS is required in production");
      for (const NODE_ENV of ["development", "test"]) expect(() => assertEnabledLangsConfigured({ NODE_ENV, ENABLED_LANGS })).not.toThrow();
    }
    expect(() => assertEnabledLangsConfigured({ NODE_ENV: "production", ENABLED_LANGS: "ja,en" })).not.toThrow();
  });

  it("is part of assertStartupConfig, also before the production-only checks", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", ENABLED_LANGS: "ja,xx" })).toThrow("unknown language tag");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "test", ENABLED_LANGS: "fr,de" })).not.toThrow();
  });
});

describe("assertEnabledLangsReviewed", () => {
  const clean = { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 };
  const counts: ReviewCounts = {
    ja: clean,
    en: clean,
    fr: { unverified: 552, unverifiedPublic: 552, missing: 65, stale: 0, verifiedAt: null },
    "zh-Hans": { unverified: 12, unverifiedPublic: 12, missing: 0, stale: 0, verifiedAt: "2026-10-05" },
    "zh-Hant": { unverified: 0, unverifiedPublic: 0, missing: 3, stale: 0, verifiedAt: "2026-10-05" },
    de: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0, verifiedAt: "2026-10-06" },
  };
  const prod = (ENABLED_LANGS: string) => ({ NODE_ENV: "production", ENABLED_LANGS });

  it("stops production when an enabled language has missing strings, and names the language, the counts and the way out", () => {
    expect(() => assertEnabledLangsReviewed(prod("ja,en,fr"), counts)).toThrow(/fr: .*missing.*552 unchecked/);
    expect(() => assertEnabledLangsReviewed(prod("ja,en,fr"), counts)).toThrow(/--verify --lang <tag> --by <name> --all/);
    expect(() => assertEnabledLangsReviewed(prod("ja,en,zh-Hant"), counts)).toThrow(/zh-Hant: .*missing/);
  });

  it("stops production when an enabled language has only unchecked machine translations", () => {
    expect(() => assertEnabledLangsReviewed(prod("ja,zh-Hans"), counts)).toThrow(/zh-Hans: .*12 unchecked/);
  });

  it("tells what to do in an emergency: remove the language from ENABLED_LANGS and restart (the site starts with the others)", () => {
    let message = "";
    try {
      assertEnabledLangsReviewed(prod("ja,en,fr"), counts);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("In an emergency");
    expect(message).toContain("remove the language from ENABLED_LANGS and restart");
    expect(message).toContain("docs/deploy.md section 13");
  });

  it("names every offending language at once", () => {
    expect(() => assertEnabledLangsReviewed(prod("ja,en,fr,zh-Hans,zh-Hant"), counts)).toThrow(/fr: .*zh-Hant: .*zh-Hans: /);
  });

  it("lets through ja and en, a language with both counts at 0, and languages that are not enabled (however unchecked)", () => {
    expect(() => assertEnabledLangsReviewed(prod("ja,en"), counts)).not.toThrow();
    expect(() => assertEnabledLangsReviewed(prod("ja,en,de"), counts)).not.toThrow();
    // Hand-written languages need no machine-translation verification, but structural problems still block startup.
    expect(() => assertEnabledLangsReviewed(prod("ja,en"), { ja: { unverified: 5, unverifiedPublic: 5, missing: 0, stale: 0 }, en: { unverified: 5, unverifiedPublic: 5, missing: 0, stale: 0 } })).not.toThrow();
  });

  it("is skipped in development and test, even for a language that is not reviewed and with no counts", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(() => assertEnabledLangsReviewed({ NODE_ENV, ENABLED_LANGS: "ja,en,fr" }, counts)).not.toThrow();
      expect(() => assertEnabledLangsReviewed({ NODE_ENV, ENABLED_LANGS: "ja,en,fr" }, null)).not.toThrow();
    }
  });

  it("stops production when the build embedded no counts, or none for an enabled language", () => {
    expect(() => assertEnabledLangsReviewed(prod("ja,en"), null)).toThrow("did not embed the review counts");
    expect(() => assertEnabledLangsReviewed(prod("ja,ko"), counts)).toThrow("ko: no review counts");
  });

  it("rejects missing or stale messages even when verification counts are clear, including hand-written languages", () => {
    for (const lang of ["ja", "en", "de"] as const) {
      for (const field of ["missing", "stale"] as const) {
        const broken = { ...counts, [lang]: { ...clean, [field]: 1 } };
        expect(() => assertEnabledLangsReviewed(prod(`ja,en,${lang}`), broken)).toThrow(`${lang}: ${field === "missing" ? "1 missing and 0 stale" : "0 missing and 1 stale"}`);
      }
    }
    expect(() => assertEnabledLangsReviewed(prod("ja,en"), { en: clean })).toThrow("ja: no review counts");
  });

  it("fails closed on old, malformed or negative structural counts, including ja and en", () => {
    for (const lang of ["ja", "en", "de"] as const) {
      for (const review of [{ unverified: 0 }, { ...clean, missing: -1 }, { ...clean, stale: 0.5 }]) {
        expect(() => assertEnabledLangsReviewed(prod(`ja,en,${lang}`), { ...counts, [lang]: review } as ReviewCounts)).toThrow(`${lang}: invalid review counts`);
      }
    }
  });

  it("never exempts missing keys in a hand-written language", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(() => assertEnabledLangsReviewed(prod("ja,en"), { ...counts, [lang]: { ...clean, missing: 1 } })).toThrow(`${lang}: 1 missing`);
    }
  });
});

describe("computeReviewCounts and parseReviewCounts", () => {
  const source = { $schema: "s", a: "A", b: "B" };
  it("counts like --check --require-verified and survives a round trip through the file shape", () => {
    const files = { en: source, ja: { $schema: "s", a: "あ", b: "い" }, fr: { $schema: "s", b: "Bé" }, de: { $schema: "s", a: "Ä", b: "Bö" } };
    const hashes = { fr: { b: "x" }, de: { a: "x", b: "y" } } as Record<string, Record<string, string>>;
    const counts = computeReviewCounts(source, files, hashes, {}, { de: [{ by: "Someone", at: "2026-10-02", keys: 2 }, { by: "Someone", at: "2026-10-09", keys: 1 }] });
    expect(counts.ja).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 0, stale: 2 });
    expect(counts.fr).toMatchObject({ unverified: 1, unverifiedPublic: 1, missing: 1, stale: 1, verifiedAt: null });
    expect(counts.de).toMatchObject({ unverified: 2, unverifiedPublic: 2, missing: 0, stale: 2, verifiedAt: "2026-10-09" });
    // a language without a file can never pass
    expect(counts.ko.missing).toBe(2);
    expect(Object.keys(counts)).toEqual([...LANGS]);
    expect(parseReviewCounts(JSON.parse(JSON.stringify(counts)))).toEqual(counts);
    expect(JSON.stringify(counts)).not.toContain("Someone");
  });

  it("treats anything else as no counts", () => {
    expect(parseReviewCounts(null)).toBeNull();
    expect(parseReviewCounts([])).toBeNull();
    expect(parseReviewCounts({ fr: { missing: "1", unverified: 0 } })).toBeNull();
    expect(parseReviewCounts({ fr: null })).toBeNull();
    const clean = { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 };
    for (const field of ["unverified", "unverifiedPublic", "missing", "stale"] as const) {
      for (const value of [-1, 0.5, "0", undefined, Number.MAX_SAFE_INTEGER + 1]) {
        expect(parseReviewCounts({ en: { ...clean, [field]: value } })).toBeNull();
      }
    }
    expect(parseReviewCounts({ ja: { unverified: 0 } })).toBeNull();
    expect(parseReviewCounts({ en: { ...clean, verifiedAt: 42 } })).toBeNull();
  });

  it("counts missing keys and obsolete source fingerprints separately from completeness and verification", () => {
    const files = { en: source, ja: { a: "あ" }, fr: { a: "French A" }, de: { a: "A", b: "B old" } };
    const hashes = { fr: { a: fingerprint(source.a) }, de: { a: fingerprint(source.a), b: fingerprint(`${source.b} old`) } };
    const counts = computeReviewCounts(source, files, hashes, {}, {});
    expect(counts.ja).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 1, stale: 1 });
    expect(counts.fr).toMatchObject({ unverified: 1, unverifiedPublic: 1, missing: 1, stale: 0 });
    expect(counts.de).toMatchObject({ unverified: Object.keys(files.de).length, unverifiedPublic: Object.keys(files.de).length, missing: [].length, stale: ["b"].length });
    expect(computeReviewCounts(source, { ja: source }, {}, {}, {}).en.missing).toBe(2);
    expect(computeReviewCounts({}, {}, {}, {}, {}).ja.missing).toBe(1);
  });
});

// ---- translation jobs, translations shown, and the choice lists (all of them follow ENABLED_LANGS) ----
const t0 = new Date("2026-10-05T00:00:00Z");

const fakeEngines = (): EngineSet => ({ primary: createFakeEngine(), secondary: createFakeEngine(), judge: createFakeJudge() });
// Divergence measurement samples translations (DIVERGENCE_SAMPLE_RATE, default 0): measure all of them here.
const runJobs = (db: Db) => runDueJobs(db, createTranslationHandlers({ llm: { engines: fakeEngines(), env: { DIVERGENCE_SAMPLE_RATE: "1" } } }), { now: t0, logger: quiet, limit: 1000 });
const queuedLangs = async (db: Db, kind: string, entryId?: number) =>
  (await db.select().from(jobs).where(eq(jobs.kind, kind)))
    .filter((j) => entryId === undefined || (j.payload as { entryId: number }).entryId === entryId)
    .map((j) => (j.payload as { lang: string }).lang)
    .sort();

describe("translation jobs are limited to the enabled languages", () => {
  async function setup() {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    return db;
  }

  it("queues one job per enabled language except the original, on publish (topic and reply) and on edit", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "en", title: "A title", body: "A body." });
    if (!topic.ok) throw new Error("topic failed");
    expect(await queuedLangs(db, "translate_entry", topic.id)).toEqual(["ja"]);
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信です。" });
    if (!reply.ok) throw new Error("reply failed");
    expect(await queuedLangs(db, "translate_entry", reply.id)).toEqual(["en"]);
    await editEntry(db, "u1", topic.id, { title: "A title", body: "An edited body." });
    // the edit queued one more job for the new version, again only for ja
    expect(await queuedLangs(db, "translate_entry", topic.id)).toEqual(["ja", "ja"]);
  });

  it("queues all eight other languages when ENABLED_LANGS is unset (the development default)", async () => {
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error("topic failed");
    expect(await queuedLangs(db, "translate_entry", topic.id)).toEqual(LANGS.filter((l) => l !== "ja").sort());
  });

  it("finishes a queued job for a language that is not enabled any more without translating (the job is done, no row is written)", async () => {
    const db = await setup();
    // queued while all nine languages were enabled ...
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error("topic failed");
    expect(await queuedLangs(db, "translate_entry", topic.id)).toHaveLength(8);
    // ... run after the language was closed
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const stats = await runJobs(db);
    // Eight title jobs and eight body jobs (seven languages are closed), plus the English divergence measurement.
    expect(stats).toMatchObject({ ran: 17, done: 17, failed: 0, deferred: 0 });
    const langs = [...new Set((await db.select({ lang: translations.lang }).from(translations).where(eq(translations.entryId, topic.id))).map((r) => r.lang))];
    expect(langs).toEqual(["en"]);
    expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).every((j) => j.status === "done")).toBe(true);
  });

  it("does not queue measure_divergence for a language that is not enabled, and finishes one that was queued without measuring", async () => {
    const db = await setup();
    // all nine enabled: translate all, which queues a divergence measurement per language
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error("topic failed");
    const handlers = createTranslationHandlers({ llm: { engines: fakeEngines(), env: { DIVERGENCE_SAMPLE_RATE: "1" } } });
    // run only the translate jobs once; the divergence jobs they queue are for the languages enabled at that time
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    await runDueJobs(db, { translate_entry: handlers.translate_entry }, { now: t0, logger: quiet, limit: 1000 });
    expect(await queuedLangs(db, "measure_divergence", topic.id)).toEqual(["en"]);
    // a measurement for fr that was queued earlier (when fr was enabled) finishes as a no-op
    await enqueue(db, "measure_divergence", { entryId: topic.id, lang: "fr", sourceHash: (await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topic.id)))[0].h! });
    const stats = await runDueJobs(db, { measure_divergence: handlers.measure_divergence }, { now: t0, logger: quiet, limit: 1000 });
    expect(stats).toMatchObject({ failed: 0, deferred: 0 });
    const secondary = await db.select().from(translations).where(eq(translations.kind, "secondary"));
    expect(secondary.map((r) => r.lang)).toEqual(["en"]);
  });

  it("queues no divergence measurement through requeue for a language that is not enabled", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error("topic failed");
    await runJobs(db);
    await db.delete(jobs);
    // translations exist for en only; a requeue with divergence on queues for en and never for another language
    const res = await requeueTranslations(db, { divergence: true, llm: { engines: fakeEngines(), env: { DIVERGENCE_SAMPLE_RATE: "1" } } });
    expect(res.translate).toBe(0);
    // the only measurement that may be queued is for en (a topic in ja; ja is the original)
    expect((await queuedLangs(db, "measure_divergence")).every((l) => l === "en")).toBe(true);
  });
});

describe("requeueTranslations follows ENABLED_LANGS", () => {
  it("queues only the enabled languages, topics before replies and the most recent activity first; langs narrows it; a language that is not enabled is an error", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const old = await createTopic(db, "u1", { lang: "ja", title: "古い", body: "古い本文。" });
    const recent = await createTopic(db, "u1", { lang: "ja", title: "新しい", body: "新しい本文。" });
    if (!old.ok || !recent.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", old.id, { lang: "ja", body: "返信。" });
    if (!reply.ok) throw new Error("reply failed");
    await db.delete(jobs);
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");

    const all = await requeueTranslations(db);
    expect(all).toMatchObject({ entries: 3, translate: 6 });
    expect(await queuedLangs(db, "translate_entry")).toEqual(["en", "en", "en", "fr", "fr", "fr"]);
    // order of the queue: topics first, newest activity first (the old topic was replied to last, so it is the most active)
    const order = (await db.select().from(jobs).where(eq(jobs.kind, "translate_entry")).orderBy(asc(jobs.id))).map((j) => (j.payload as { entryId: number }).entryId);
    expect(order.slice(0, 4).sort()).toEqual([old.id, old.id, recent.id, recent.id].sort());
    expect(order.slice(4)).toEqual([reply.id, reply.id]);
    const firstTopic = order[0];
    expect([old.id, recent.id]).toContain(firstTopic);

    // langs narrows it to one language; a second run queues nothing new
    await db.delete(jobs);
    expect(await requeueTranslations(db, { langs: ["fr"] })).toMatchObject({ translate: 3 });
    expect(await queuedLangs(db, "translate_entry")).toEqual(["fr", "fr", "fr"]);
    expect(await requeueTranslations(db, { langs: ["fr"] })).toMatchObject({ translate: 0 });

    // a language that is not enabled is refused (nothing is queued)
    await db.delete(jobs);
    await expect(requeueTranslations(db, { langs: ["de"] })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(requeueTranslations(db, { langs: ["fr", "de"] })).rejects.toBeInstanceOf(RequeueLangError);
    expect(await queuedLangs(db, "translate_entry")).toEqual([]);
  });

  it("puts topics before replies even when a reply is the most recent activity", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文。" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信。" });
    if (!reply.ok) throw new Error("reply failed");
    await db.delete(jobs);
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    await requeueTranslations(db);
    const order = (await db.select().from(jobs).orderBy(asc(jobs.id))).map((j) => (j.payload as { entryId: number }).entryId);
    expect(order).toEqual([topic.id, topic.id, reply.id]);
  });
});

describe("translations that are shown, and the languages of the readers, follow ENABLED_LANGS", () => {
  it("resolveDisplayLang uses ?lang= and the saved display language only when enabled, then the first enabled language the member reads, then the default", () => {
    const profile = { displayLang: "fr" as Lang | null, readLangs: ["de", "ja"] as Lang[] };
    const enabled: readonly Lang[] = ["ja", "en"];
    expect(resolveDisplayLang({ query: "en", profile, enabled })).toBe("en");
    expect(resolveDisplayLang({ query: "de", profile, enabled })).toBe("ja");
    expect(resolveDisplayLang({ profile, enabled })).toBe("ja");
    expect(resolveDisplayLang({ profile: { displayLang: null, readLangs: ["de"] }, enabled })).toBe("en");
    expect(resolveDisplayLang({ profile: { displayLang: null, readLangs: [] }, enabled: ["ja", "fr"] })).toBe("ja");
    // unchanged when every language is enabled
    expect(resolveDisplayLang({ query: "de", profile })).toBe("de");
  });

  it("displayLangFor and langQueryParam ignore a language that is not enabled", () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const profile = { displayLang: null, readLangs: ["ja"] } as unknown as Profile;
    expect(displayLangFor(new Request("https://x.example/?lang=en"), profile)).toBe("en");
    expect(displayLangFor(new Request("https://x.example/?lang=th"), profile)).toBe("en");
    expect(langQueryParam(new Request("https://x.example/?lang=th"))).toBeNull();
    expect(langQueryParam(new Request("https://x.example/?lang=en"))).toBe("en");
  });

  it("the Markdown twins do not list or serve a translation into a language that is not enabled, and answer ?lang= of one with 400 invalid_lang", async () => {
    const h = await setupRouteHarness();
    try {
      await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
      const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "題", body: "本文。" });
      if (!topic.ok) throw new Error("topic failed");
      const [row] = await h.db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, topic.id));
      for (const lang of ["en", "fr"]) {
        await h.db.insert(translations).values({ entryId: topic.id, field: "body", lang, kind: "primary", text: `[${lang}] body`, engine: "fake", model: "fake-1", sourceHash: row.hash });
      }
      // the rows for fr stay in the database (never deleted), but fr is not enabled
      vi.stubEnv("ENABLED_LANGS", "ja,en");
      const listed = await loadMdTranslations(h.db, [{ id: topic.id, lang: "ja", sourceHash: row.hash }], null);
      expect(listed.langs.get(topic.id)).toEqual(["en"]);
      const ok = await getMd(h, `/t/${topic.id}.md?lang=en`, { as: "hana" });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("[en] body");
      const bad = await getMd(h, `/t/${topic.id}.md?lang=fr`, { as: "hana" });
      expect(bad.status).toBe(400);
      expect(await bad.text()).toMatch(/invalid_lang[\s\S]*ja, en/);
      // the original is always readable: the list of a language that is not enabled still opens
      expect((await getMd(h, "/a/fr.md", { as: "hana" })).status).toBe(200);
      expect((await getMd(h, `/search.md?q=x&lang=fr`, { as: "hana" })).status).toBe(400);
    } finally {
      h.restore();
    }
  });

  it("the language of a mail is an enabled language: a member whose saved interface language is not enabled gets the default", () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(mailLocale("ja")).toBe("ja");
    expect(mailLocale("de")).toBeNull();
    expect(mailLocale("klingon")).toBeNull();
    expect(mailLocale(null)).toBeNull();
    expect(mailLocale("de") ?? defaultUiLocale()).toBe("en");
    vi.stubEnv("ENABLED_LANGS", "ja,de");
    expect(mailLocale("de")).toBe("de");
  });

  it("settings refuses a translation preference that is not enabled", async () => {
    const h = await setupRouteHarness();
    try {
      await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
      const route = await import("~/routes/settings");
      vi.stubEnv("ENABLED_LANGS", "ja,en");
      const bad = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", homeArea: "ja", readLangs: "ja", displayLang: "fr" } }))));
      expect(bad.status).toBe(400);
      const ok = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", homeArea: "ja", readLangs: "ja", displayLang: "en" } }))));
      expect(ok).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
      expect((await getProfile(h.db, h.ids.hana))!.displayLang).toBe("en");
    } finally {
      h.restore();
    }
  });
});

// ---- a source scan: posting/UI choices follow the enabled languages ----
describe("the screens take their language choices from the enabled languages", () => {
  // Removes imports, block comments, line comments and JSX comments, so that only code is searched.
  const codeOf = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/([^:\w"'`])\/\/.*$/gm, "$1");

  // Operator and moderator screens keep all nine languages on purpose (a language is prepared before it is opened).
  const ALLOWED = new Set(["admin-roles.tsx", "admin-glossary.tsx"]);

  it("app/components/*.tsx and app/routes/*.{ts,tsx} do not use LANGS (use useEnabledLangs, enabledLangs() or the data of a loader), except operator screens", () => {
    const files = [
      ...fs.readdirSync("app/components").filter((f) => f.endsWith(".tsx")).map((f) => path.join("app/components", f)),
      ...fs.readdirSync("app/routes").filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => path.join("app/routes", f)),
    ];
    expect(files.length).toBeGreaterThan(40);
    const offenders = files.filter((f) => !ALLOWED.has(path.basename(f))).filter((f) => /\bLANGS\b/.test(codeOf(fs.readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("the scan itself sees code and ignores comments and imports", () => {
    expect(/\bLANGS\b/.test(codeOf('import { LANGS } from "~/lib/languages";\n// LANGS in a comment\n/* LANGS */\nconst x = 1;'))).toBe(false);
    expect(/\bLANGS\b/.test(codeOf('const FILTER_LANGS = LANGS; // all\n'))).toBe(true);
    expect(/\bLANGS\b/.test(codeOf("{LANGS.map((l) => l)}"))).toBe(true);
  });
});

// ---- translation reports and the automatic retry follow ENABLED_LANGS ----
describe("translation reports and the automatic re-translation only concern enabled languages", () => {
  async function reportSetup() {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "u2", "somchai", { readLangs: ["th"] });
    const topic = await createTopic(db, "u1", { lang: "ja", title: "話題の題", body: "話題の本文です。" });
    if (!topic.ok) throw new Error("topic failed");
    // every language is enabled here (the default), so the translations into all of them exist
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } }), { now: t0, logger: quiet, limit: 500 });
    return { db, topicId: topic.id };
  }
  const seen: string[] = [];
  const retryLlm = () => {
    const base = createFakeEngine({ model: "fake-retry" });
    const retry = {
      id: "fake" as const,
      model: "fake-retry",
      async translate(req: Parameters<typeof base.translate>[0]) {
        seen.push(req.to);
        return base.translate(req);
      },
    };
    return { engines: { primary: createFakeEngine(), secondary: null, judge: null, retry }, env: {} };
  };

  it("refuses to report a translation into a language that is not enabled (invalid_lang): no row, no retry job, however old the translation row is", async () => {
    const { db, topicId } = await reportSetup();
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    // th has an old (current) translation row, but the language is not enabled: the old behaviour queued a paid retry here
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "th" }, { now: t0, llm: retryLlm() })).toEqual({ ok: false, error: "invalid_lang" });
    // a language that never had a row is refused for the same reason, not left as an open item for a language nobody moderates
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "ko", note: "wrong" }, { now: t0, llm: retryLlm() })).toEqual({ ok: false, error: "invalid_lang" });
    expect(await db.select().from(translationReports)).toHaveLength(0);
    expect(await db.select().from(jobs).where(eq(jobs.kind, RETRANSLATE_REPORT_JOB))).toHaveLength(0);
    // an enabled language still works
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "en" }, { now: t0, llm: retryLlm() })).toMatchObject({ ok: true, route: "retry" });
  });

  it("a report made while the language was enabled goes to the moderators, without calling the engine, when the retry job runs after the language was closed", async () => {
    const { db, topicId } = await reportSetup();
    const made = await createTranslationReport(db, "u2", { entryId: topicId, lang: "th" }, { now: t0, llm: retryLlm() });
    expect(made).toMatchObject({ ok: true, route: "retry" });
    const before = (await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body"))))[0];
    seen.length = 0;
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const stats = await runDueJobs(db, createTranslationHandlers({ llm: retryLlm() }), { now: new Date(t0.getTime() + 1000), logger: quiet, limit: 100 });
    expect(stats).toMatchObject({ failed: 0, deferred: 0 });
    expect(seen).toEqual([]);
    const [row] = await db.select().from(translationReports);
    expect(row).toMatchObject({ route: "moderator", status: "open" });
    expect((await db.select().from(jobs).where(eq(jobs.kind, RETRANSLATE_REPORT_JOB))).every((j) => j.status === "done")).toBe(true);
    // the translation itself was not touched
    const after = (await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body"))))[0];
    expect(after.text).toBe(before.text);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});
