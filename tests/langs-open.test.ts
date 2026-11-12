import { quietLogger as quiet } from "./helpers/logger";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, glossaryEntries, glossaryRevisions, jobs, llmUsage, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { clearNeedsReviewBulk, createGlossaryEntry, deleteGlossaryEntry, needsReviewSummary } from "~/lib/glossary.server";
import { defaultReviewCounts, estimateTranslationCost, runOpenLang } from "~/lib/langs-open.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { ReviewCounts } from "~/lib/i18n/review-counts";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { addMember, createTestDb } from "./helpers/db";

// pnpm langs:open <tag>: queues the existing posts for translation into a language that was just enabled, through the ordinary queue.
afterEach(() => vi.unstubAllEnvs());

const t0 = new Date("2026-10-05T00:00:00Z");

const READY: ReviewCounts = {
  ja: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 },
  en: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 },
  fr: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0, verifiedAt: "2026-10-06" },
  de: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 },
  "zh-Hant": { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 },
  "zh-Hans": { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 },
  ko: { unverified: 100, unverifiedPublic: 100, missing: 3, stale: 0 },
  th: { unverified: 12, unverifiedPublic: 12, missing: 0, stale: 0 },
  vi: { unverified: 0, unverifiedPublic: 0, missing: 5, stale: 0 },
};
// A key for the primary engine (no call is made: langs:open only queues). Gemini is the production engine.
const REAL_ENV = { ENABLED_LANGS: "ja,en,fr,ko,th,vi", GEMINI_API_KEY: "test-key-not-used", ANTHROPIC_API_KEY: "" };

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  // Posts written while only ja and en were enabled: no jobs for fr.
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const older = await createTopic(db, "u1", { lang: "ja", title: "古い話題", body: "古い話題の本文です。" });
  const recent = await createTopic(db, "u1", { lang: "en", title: "A recent topic", body: "The body of the recent topic." });
  if (!older.ok || !recent.ok) throw new Error("topic failed");
  const reply = await createReply(db, "u1", older.id, { lang: "ja", body: "返信です。" });
  if (!reply.ok) throw new Error("reply failed");
  vi.unstubAllEnvs();
  return { db, older: older.id, recent: recent.id, reply: reply.id };
}

function harness(db: Db | null, over: { env?: Record<string, string | undefined>; counts?: ReviewCounts | (() => never) } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const getDb = vi.fn(async () => {
    if (!db) throw new Error("the database must not be opened");
    return db;
  });
  const counts = over.counts ?? READY;
  return {
    out,
    err,
    getDb,
    run: (...argv: string[]) =>
      runOpenLang(argv, {
        env: over.env ?? REAL_ENV,
        getDb,
        reviewCounts: typeof counts === "function" ? counts : () => counts,
        log: (l) => out.push(l),
        error: (l) => err.push(l),
      }),
  };
}

const queued = (db: Db, lang?: string) =>
  db
    .select()
    .from(jobs)
    .where(eq(jobs.kind, "translate_entry"))
    .orderBy(asc(jobs.id))
    .then((rows) => rows.filter((j) => lang === undefined || (j.payload as { lang: string }).lang === lang));

describe("langs:open: refusals, all before any database is opened", () => {
  it("needs exactly one tag that the software supports, and rejects unknown options", async () => {
    for (const argv of [[], ["fr", "de"], ["--dry-run"], ["klingon"], ["zh"], ["fr", "--force"]]) {
      const h = harness(null);
      expect(await h.run(...argv), argv.join(" ")).toBe(1);
      expect(h.getDb).not.toHaveBeenCalled();
      expect(h.err.join("\n")).toMatch(/usage: pnpm langs:open|not a language of this software/);
    }
    // Chinese is named by script
    const h = harness(null);
    await h.run("zh");
    expect(h.err.join("\n")).toContain("zh-Hant");
  });

  it("stops when the language is not in ENABLED_LANGS, telling to add it and restart first", async () => {
    const h = harness(null, { env: { ...REAL_ENV, ENABLED_LANGS: "ja,en" } });
    expect(await h.run("fr")).toBe(1);
    expect(h.err.join("\n")).toMatch(/fr is not in ENABLED_LANGS \(ja,en\)\. Add fr to ENABLED_LANGS and restart the app first/);
    expect(h.getDb).not.toHaveBeenCalled();
    // a malformed ENABLED_LANGS is an error too
    const bad = harness(null, { env: { ...REAL_ENV, ENABLED_LANGS: "ja,xx" } });
    expect(await bad.run("ja")).toBe(1);
    expect(bad.err.join("\n")).toContain("unknown language tag");
  });

  it("stops when the primary translation engine is fake (a refusal before the database is opened), unless --allow-fake", async () => {
    const h = harness(null, { env: { ENABLED_LANGS: "ja,en,fr", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", TRANSLATION_PRIMARY: "" } });
    expect(await h.run("fr")).toBe(1);
    expect(h.err.join("\n")).toMatch(/langs:open refused: the primary translation engine is "fake"/);
    expect(h.getDb).not.toHaveBeenCalled();
    // with --allow-fake it goes on (the database is opened)
    const { db } = await setup();
    const allowed = harness(db, { env: { ENABLED_LANGS: "ja,en,fr", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
    expect(await allowed.run("fr", "--allow-fake")).toBe(0);
    expect(allowed.getDb).toHaveBeenCalledOnce();
  });

  it("stops while the interface strings of the language are missing or unchecked, naming the counts and the way out; there is no --force", async () => {
    for (const [tag, text] of [
      ["ko", /3 missing.*100 unchecked/],
      ["th", /12 unchecked/],
      ["vi", /5 missing/],
    ] as const) {
      const h = harness(null);
      expect(await h.run(tag), tag).toBe(1);
      expect(h.err.join("\n")).toMatch(text);
      expect(h.err.join("\n")).toContain("Fix missing/stale strings");
      expect(h.err.join("\n")).toContain(`--verify --lang ${tag} --by "<name>" --all`);
      expect(h.getDb).not.toHaveBeenCalled();
    }
    const force = harness(null);
    expect(await force.run("ko", "--force")).toBe(1);
    expect(force.err.join("\n")).toContain("unknown option: --force");
  });

  it("stops when there are no counts for the language, and when the counts cannot be read", async () => {
    const h = harness(null, { counts: { ja: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 }, en: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 } } });
    expect(await h.run("fr")).toBe(1);
    expect(h.err.join("\n")).toContain("no review counts in the build");
    const broken = harness(null, {
      counts: () => {
        throw new Error("messages/en.json is missing");
      },
    });
    expect(await broken.run("fr")).toBe(1);
    expect(broken.err.join("\n")).toContain("messages/en.json is missing");
  });

  it("refuses incomplete, stale or legacy review counts before opening the database, also for hand-written languages", async () => {
    for (const tag of ["ja", "en", "fr"] as const) {
      for (const field of ["missing", "stale"] as const) {
        const h = harness(null, { counts: { ...READY, [tag]: { ...READY[tag], [field]: 1 } } });
        expect(await h.run(tag)).toBe(1);
        expect(h.err.join("\n")).toContain(field === "missing" ? "1 missing and 0 stale" : "0 missing and 1 stale");
        expect(h.getDb).not.toHaveBeenCalled();
      }
      const legacy = harness(null, { counts: { ...READY, [tag]: { unverified: 0 } } as ReviewCounts });
      expect(await legacy.run(tag)).toBe(1);
      expect(legacy.err.join("\n")).toContain("invalid review counts");
      expect(legacy.getDb).not.toHaveBeenCalled();
    }
  });

  it("requires structural counts but not native verification for hand-written languages", async () => {
    const { db } = await setup();
    const h = harness(db, { env: { ...REAL_ENV, ENABLED_LANGS: "ja,en" }, counts: { en: { unverified: 9, unverifiedPublic: 9, missing: 0, stale: 0 }, fr: { unverified: 9, unverifiedPublic: 9, missing: 9, stale: 0 } } });
    expect(await h.run("en", "--dry-run")).toBe(0);
  });

  it("does not exempt missing keys in hand-written languages", async () => {
    for (const tag of ["ja", "en"] as const) {
      const h = harness(null, { counts: { ...READY, [tag]: { ...READY[tag], missing: 1 } } });
      expect(await h.run(tag)).toBe(1);
      expect(h.err.join("\n")).toContain("1 missing");
      expect(h.getDb).not.toHaveBeenCalled();
    }
  });
});

describe("langs:open: queueing", () => {
  it("queues the posts that have no translation into the language yet, topics first and the most recent first, and says what happens next", async () => {
    const { db, older, recent, reply } = await setup();
    const h = harness(db);
    expect(await h.run("fr")).toBe(0);
    const rows = await queued(db, "fr");
    // three posts, none of them in fr
    expect(rows.map((j) => (j.payload as { entryId: number }).entryId).sort()).toEqual([older, recent, reply].sort());
    // topics first; the reply comes last
    expect((rows.at(-1)!.payload as { entryId: number }).entryId).toBe(reply);
    expect(rows.every((j) => j.status === "queued" && j.maxAttempts === 10)).toBe(true);
    // nothing for other languages was queued by this command: fr only
    expect((await queued(db, "ko")).length).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("queued 3 translate_entry job(s) into fr");
    expect(text).toContain("/admin/usage");
    expect(text).toMatch(/responder/);
    expect(h.err).toEqual([]);
  });

  it("does not queue twice: a second run queues nothing, and posts that already have a current translation are left alone", async () => {
    const { db, older } = await setup();
    const h = harness(db);
    await h.run("fr");
    expect(await queued(db, "fr")).toHaveLength(3);
    const again = harness(db);
    expect(await again.run("fr")).toBe(0);
    expect(again.out.join("\n")).toContain("queued 0 translate_entry job(s)");
    expect(await queued(db, "fr")).toHaveLength(3);
    // run the queue (fake engine): the translations exist, and a later run has nothing to do
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null } } }), { now: t0, logger: quiet, limit: 100 });
    expect((await db.select().from(translations).where(and(eq(translations.entryId, older), eq(translations.lang, "fr")))).length).toBeGreaterThan(0);
    const done = harness(db);
    await done.run("fr");
    expect(done.out.join("\n")).toContain("queued 0 translate_entry job(s)");
  });

  it("--dry-run queues nothing and reports the number of (post x language) translations, the characters and a cost estimate with the primary model", async () => {
    const { db } = await setup();
    const jobsBefore = (await queued(db)).length;
    const h = harness(db);
    expect(await h.run("fr", "--dry-run")).toBe(0);
    expect(await queued(db)).toHaveLength(jobsBefore);
    expect(await queued(db, "fr")).toHaveLength(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/dry run: 3 \(post x language\) translation\(s\) into fr would be queued \(\d+ source characters\); nothing was queued/);
    expect(text).toMatch(/estimated cost with gemini\/gemini-[\w.-]+: about \$\d+\.\d\d/);
    // the cost estimate is deliberately not zero for a real engine and zero for the fake one
    expect(estimateTranslationCost({ GEMINI_API_KEY: "k" }, 3, 1000).usd).toBeGreaterThan(0);
    expect(estimateTranslationCost({}, 3, 1000).usd).toBe(0);
  });

  it("queued jobs wait while the monthly budget is stopped, and finish when it is raised (the budget path of the ordinary queue)", async () => {
    const { db } = await setup();
    await harness(db).run("fr");
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    // a monthly budget of $1 and $1 already spent this month: stopped
    await db.insert(llmUsage).values({ engine: "gemini", model: "gemini-3.1-flash-lite", purpose: "translate", costUsdMicro: 1_000_000, createdAt: t0 });
    const handlers = (budget: string) => createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: { LLM_MONTHLY_BUDGET_USD: budget } } });
    // Ten jobs: body work for three posts and title work for two topics, into en and fr.
    const stopped = await runDueJobs(db, handlers("1"), { now: t0, logger: quiet, limit: 100 });
    expect(stopped).toMatchObject({ ran: 10, deferred: 10, done: 0, failed: 0 });
    expect((await queued(db, "fr")).every((j) => j.status === "queued" && j.attempts === 0)).toBe(true);
    const resumed = await runDueJobs(db, handlers("20"), { now: new Date(t0.getTime() + 16 * 60_000), logger: quiet, limit: 100 });
    expect(resumed).toMatchObject({ done: 10, deferred: 0 });
    const fr = await db.select().from(translations).where(eq(translations.lang, "fr"));
    // three posts: title and body of the two topics, body of the reply
    expect(fr).toHaveLength(5);
  });

  it("requeueTranslations narrowed to a language queues nothing for the others", async () => {
    const { db } = await setup();
    await requeueTranslations(db, { allMissing: true, langs: ["fr"], env: REAL_ENV });
    expect((await queued(db, "fr")).length).toBe(3);
    expect((await queued(db, "vi")).length).toBe(0);
    expect((await queued(db, "th")).length).toBe(0);
  });

  it("opens every missing pair and preserves dry-run counts under the readers policy", async () => {
    const { db } = await setup();
    const h = harness(db, { env: { ...REAL_ENV, TRANSLATION_EAGER_SCOPE: "readers" } });
    const before = await db.select().from(jobs);
    expect(await h.run("fr", "--dry-run")).toBe(0);
    expect(h.out.join("\n")).toContain("3 (post x language) translation(s) into fr");
    expect(await db.select().from(jobs)).toEqual(before);
    expect(await h.run("fr")).toBe(0);
    expect(await queued(db, "fr")).toHaveLength(3);
  });
});

describe("langs:open: glossary review", () => {
  const actor = { userId: "u1", scope: { operator: true, langs: [] } };
  const make = async (db: Db, term: string, targetLang: string, options: { lang?: string; needsReview?: boolean; deleted?: boolean } = {}) => {
    const result = await createGlossaryEntry(db, actor, {
      term,
      lang: options.lang ?? "en",
      targetLang,
      candidates: "checked candidate",
      note: "",
      keepOriginal: false,
      needsReview: options.needsReview ?? true,
    });
    if (!result.ok) throw new Error(`glossary entry failed: ${result.error}`);
    if (options.deleted) await deleteGlossaryEntry(db, actor, result.id);
    return result.id;
  };
  const glossaryState = async (db: Db) => [
    await db.select().from(glossaryEntries).orderBy(asc(glossaryEntries.id)),
    await db.select().from(glossaryRevisions).orderBy(asc(glossaryRevisions.id)),
  ];

  it("refuses both queueing and a dry run while the target language has unreviewed rows, without changing jobs or the glossary", async () => {
    const { db } = await setup();
    await make(db, "alignment", "fr");
    await make(db, "アラインメント", "fr", { lang: "ja" });
    const jobsBefore = await db.select().from(jobs).orderBy(asc(jobs.id));
    const before = await glossaryState(db);
    for (const flags of [[], ["--dry-run"]]) {
      const h = harness(db);
      expect(await h.run("fr", ...flags)).toBe(1);
      expect(h.err.join("\n")).toContain("2 active entries still need review");
      expect(h.err.join("\n")).toContain("/admin/glossary?to=fr&review=1");
      expect(h.err.join("\n")).toContain("--allow-unreviewed-glossary");
      expect(h.out).toEqual([]);
      expect(await db.select().from(jobs).orderBy(asc(jobs.id))).toEqual(jobsBefore);
      expect(await glossaryState(db)).toEqual(before);
    }
    // Reviewing the language through the ordinary bulk operation satisfies the guard.
    expect(await clearNeedsReviewBulk(db, actor, { targetLang: "fr", all: { fingerprint: (await needsReviewSummary(db, "fr")).fingerprint } })).toMatchObject({ ok: true, changed: 2 });
    expect(await harness(db).run("fr")).toBe(0);
    expect(await queued(db, "fr")).toHaveLength(3);
  });

  it("checks the target language only, ignores reviewed or deleted rows, and keeps the Chinese scripts separate", async () => {
    const { db } = await setup();
    await make(db, "alignment", "fr", { needsReview: false });
    await make(db, "agency", "fr", { deleted: true });
    await make(db, "agent", "ja", { lang: "fr" });
    await make(db, "alignment", "zh-Hans");
    const env = { ...REAL_ENV, ENABLED_LANGS: "ja,en,fr,zh-Hans,zh-Hant" };
    const h = harness(db, { env });
    expect(await h.run("fr", "--dry-run")).toBe(0);
    expect(await h.run("zh-Hant", "--dry-run")).toBe(0);
    expect(await h.run("zh-Hans", "--dry-run")).toBe(1);
    expect(h.err.join("\n")).toContain("1 active entry still needs review");
  });

  it("the explicit override allows queueing and dry runs, reports the unchecked rows, and leaves their review marks and history intact", async () => {
    const { db } = await setup();
    await make(db, "alignment", "fr");
    const before = await glossaryState(db);
    const dry = harness(db);
    expect(await dry.run("fr", "--dry-run", "--allow-unreviewed-glossary")).toBe(0);
    expect(await queued(db, "fr")).toHaveLength(0);
    expect(dry.out.join("\n")).toContain("warning: --allow-unreviewed-glossary was supplied; 1 active glossary entry still needs review for fr");
    const h = harness(db);
    expect(await h.run("fr", "--allow-unreviewed-glossary")).toBe(0);
    expect(await queued(db, "fr")).toHaveLength(3);
    expect(h.out.join("\n")).toContain("warning: --allow-unreviewed-glossary");
    expect(await glossaryState(db)).toEqual(before);
  });

  it("the glossary override cannot bypass interface review or the fake-engine guard", async () => {
    const ui = harness(null);
    expect(await ui.run("ko", "--allow-unreviewed-glossary")).toBe(1);
    expect(ui.err.join("\n")).toContain("interface strings of ko are not ready");
    expect(ui.getDb).not.toHaveBeenCalled();
    const fake = harness(null, { env: { ENABLED_LANGS: "ja,en,fr", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
    expect(await fake.run("fr", "--allow-unreviewed-glossary")).toBe(1);
    expect(fake.err.join("\n")).toContain('primary translation engine is "fake"');
    expect(fake.getDb).not.toHaveBeenCalled();
  });
});

describe("langs:open: which posts are queued, what is read, and a database that cannot be opened", () => {
  it("does not queue replies under a deleted or hidden topic, nor the deleted or hidden posts themselves", async () => {
    const { db, older, recent, reply } = await setup();
    // a second reply under `recent`, then `recent` is hidden: the reply under it is not read by anybody
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const under = await createReply(db, "u1", recent, { lang: "en", body: "A reply under a topic that will be hidden." });
    vi.unstubAllEnvs();
    if (!under.ok) throw new Error("reply failed");
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, recent));
    const h = harness(db);
    expect(await h.run("fr")).toBe(0);
    expect((await queued(db, "fr")).map((j) => (j.payload as { entryId: number }).entryId).sort()).toEqual([older, reply].sort());
    // the same when the topic is deleted
    await db.delete(jobs);
    await db.update(entries).set({ hiddenAt: null, deletedAt: new Date() }).where(eq(entries.id, recent));
    expect((await requeueTranslations(db, { allMissing: true, langs: ["fr"], env: REAL_ENV })).entries).toBe(2);
    expect((await queued(db, "fr")).map((j) => (j.payload as { entryId: number }).entryId).sort()).toEqual([older, reply].sort());
  });

  it("reads no text for a real run, and counts the characters of titles and bodies for the dry run (code points, as the database counts them)", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題名です", body: "本文です。\n\n二つ目。" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信" });
    if (!reply.ok) throw new Error("reply failed");
    vi.unstubAllEnvs();
    const [row] = await db.select({ title: entries.title, body: entries.body }).from(entries).where(eq(entries.id, topic.id));
    const expected = [...(row.title ?? "")].length + [...row.body].length + 2;
    const dry = await requeueTranslations(db, { allMissing: true, langs: ["fr"], dryRun: true, env: REAL_ENV });
    expect(dry.dryRun).toEqual({ targets: 2, chars: expected });
    const real = await requeueTranslations(db, { allMissing: true, langs: ["fr"], env: REAL_ENV });
    expect(real).toEqual({ entries: 2, translate: 2, divergence: 0, divergenceSkipped: null });
  });

  it("reports a database that cannot be opened in one line and stops with exit code 1 (no stack trace), like translations:requeue", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runOpenLang(["fr"], {
      env: REAL_ENV,
      reviewCounts: () => READY,
      getDb: async () => {
        throw new Error("the PGlite data directory is locked by another process");
      },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err).toEqual(["langs:open: could not open the database: the PGlite data directory is locked by another process"]);
    expect(out).toEqual([]);
  });
});

describe("the review counts that langs:open reads", () => {
  it("prefers the counts the build embedded, and otherwise counts messages/ the way --check --require-verified does", () => {
    const embedded: ReviewCounts = { ja: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 }, en: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 } };
    expect(defaultReviewCounts("/does/not/matter", () => embedded)).toBe(embedded);
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "langs-open-"));
    try {
      const en = { $schema: "s", a: "Hello", b: "Save" };
      const files: Record<string, Record<string, string>> = { en, ja: { $schema: "s", a: "こんにちは", b: "保存" }, fr: { $schema: "s", a: "Bonjour" } };
      for (const [locale, messages] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      // fr: "a" is translated and not checked; "b" is absent.
      fs.writeFileSync(path.join(dir, ".source-hashes.json"), JSON.stringify({ fr: { a: "0000000000000000" } }));
      const counts = defaultReviewCounts(dir, () => null);
      expect(counts.fr).toMatchObject({ missing: 1, unverified: 1 });
      expect(counts.ja).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 0, stale: 2 });
      // a language without a file can never pass
      expect(counts.ko.missing).toBe(2);
      // without messages/ files it cannot count
      expect(() => defaultReviewCounts(path.join(dir, "missing"), () => null)).toThrow("is missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("preview and operator review gates in langs:open", () => {
  it("allows unchecked public strings only in preview, preserving completeness and glossary gates", async () => {
    const counts = { fr: { unverified: 10, unverifiedPublic: 3, missing: 0, stale: 0 } };
    const normal = harness(null, { counts });
    expect(await normal.run("fr", "--dry-run")).toBe(1);
    expect(normal.getDb).not.toHaveBeenCalled();
    const preview = harness(null, { counts, env: { ...REAL_ENV, PREVIEW_LANGS: "fr" } });
    expect(await preview.run("fr", "--dry-run")).toBe(1);
    expect(preview.getDb).toHaveBeenCalledOnce();
    const operatorOnly = harness(null, { counts: { fr: { ...counts.fr, unverifiedPublic: 0 } } });
    await operatorOnly.run("fr", "--dry-run");
    expect(operatorOnly.getDb).toHaveBeenCalledOnce();
    const missing = harness(null, { counts: { fr: { ...counts.fr, missing: 1 } }, env: { ...REAL_ENV, PREVIEW_LANGS: "fr" } });
    await missing.run("fr", "--dry-run");
    expect(missing.getDb).not.toHaveBeenCalled();
    const { db } = await setup();
    expect((await createGlossaryEntry(db, { userId: "u1", scope: { operator: true, langs: [] } }, { lang: "en", targetLang: "fr", term: "test", candidates: "essai", note: "", keepOriginal: false, needsReview: true })).ok).toBe(true);
    const glossary = harness(db, { counts, env: { ...REAL_ENV, PREVIEW_LANGS: "fr" } });
    expect(await glossary.run("fr", "--dry-run")).toBe(1);
    expect(glossary.err.join("\n")).toContain("--allow-unreviewed-glossary");
    expect(await glossary.run("fr", "--dry-run", "--allow-unreviewed-glossary")).toBe(0);
  });
});
