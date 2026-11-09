import { spawnSync } from "node:child_process";
import { runGlossaryImport } from "../scripts/import-glossary";
import { runGlossaryExport } from "../scripts/export-glossary";
import { captureCli } from "./helpers/cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { glossaryEntries, glossaryRevisions } from "~/lib/db/schema";
import { updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { createTopic } from "~/lib/entries.server";
import { cleanCandidates, matchTermsOf, parseGlossaryForm, termAppearsIn } from "~/lib/glossary-forms";
import {
  buildGlossaryFile,
  canonicalGlossaryJson,
  exportGlossary,
  expandGlossaryFile,
  importGlossaryRows,
  parseGlossaryFile,
  type ImportOptions,
  serializeGlossaryFile,
  type GlossaryFile,
} from "~/lib/glossary-io.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import type { Lang } from "~/lib/languages";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { translationUserPrompt } from "~/lib/llm/prompt.server";
import type { TranslationRequest } from "~/lib/llm/types";
import { getGlossaryVersion, loadGlossary, matchGlossary } from "~/lib/translations.server";
import { addMember, createTestDb } from "./helpers/db";
import type { Db } from "~/lib/db/client.server";

// Glossary import (pnpm glossary:import): structured files create all directional rows among five languages, idempotently and with export round trips.

const root = path.resolve(import.meta.dirname, "..");
const REAL = path.join(root, "docs/drafts/glossary-initial.yaml");
const DRAFT = path.join(root, "docs/drafts/glossary-initial.md");

const FIXTURE = `
format: tomola-glossary
version: 1
entries:
  - terms:
      en: ["reward hacking"]
      ja: ["報酬ハッキング"]
      fr: ["piratage de la récompense（英語のまま使われることも多い）"]
    note: "原語のまま可。"
    keep_original: [en]
    needs_review: [fr]
  - terms:
      en: ["inner alignment / outer alignment"]
      ja: ["内部アラインメント／外部アラインメント"]
    note: ""
    keep_original: []
    needs_review: []
  - terms:
      en: ["AGI (artificial general intelligence)"]
      ja: ["汎用人工知能（AGI）", "汎用AI"]
      zh-Hans: ["通用人工智能（AGI）"]
    note: ""
`;

function fixtureFile(text = FIXTURE): GlossaryFile {
  const parsed = parseGlossaryFile(text);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.file;
}

// Import actor is operator op; a member row is required because revision updater is a foreign key to members.
const operator: GlossaryActor = { userId: "op", scope: { operator: true, langs: [] } };
async function importDb(): Promise<Db> {
  const db = await createTestDb();
  await addMember(db, "op", "opal");
  return db;
}
const importRows = (db: Db, rows: Parameters<typeof importGlossaryRows>[1], opts: ImportOptions = {}) => importGlossaryRows(db, rows, { actor: operator, ...opts });

describe("how a word with parentheses is read", () => {
  it("takes a variant spelling, an acronym or a paraphrase in parentheses as another form, and a description in another language as a note", () => {
    expect(parseGlossaryForm("AIアラインメント（AIアライメント）", "ja")).toEqual({ forms: ["AIアラインメント", "AIアライメント"], annotations: [] });
    expect(parseGlossaryForm("汎用人工知能（AGI）", "ja")).toEqual({ forms: ["汎用人工知能", "AGI"], annotations: [] });
    expect(parseGlossaryForm("existential risk (x-risk)", "en")).toEqual({ forms: ["existential risk", "x-risk"], annotations: [] });
    expect(parseGlossaryForm("intelligence artificielle générale（IAG、AGI）", "fr")).toEqual({ forms: ["intelligence artificielle générale", "IAG", "AGI"], annotations: [] });
    expect(parseGlossaryForm("评测（危险能力评测）", "zh-Hans")).toEqual({ forms: ["评测", "危险能力评测"], annotations: [] });
    expect(parseGlossaryForm("évaluations（des capacités dangereuses）", "fr")).toEqual({ forms: ["évaluations", "des capacités dangereuses"], annotations: [] });
    // The note explains the term using words in another script, kana.
    expect(parseGlossaryForm("人工智能安全（攻撃への備えの意味）", "zh-Hans")).toEqual({ forms: ["人工智能安全"], annotations: ["攻撃への備えの意味"] });
    expect(parseGlossaryForm("piratage de la récompense（英語のまま使われることも多い）", "fr")).toEqual({ forms: ["piratage de la récompense"], annotations: ["英語のまま使われることも多い"] });
    expect(parseGlossaryForm("plain", "en")).toEqual({ forms: ["plain"], annotations: [] });
  });

  it("gives the prompt clean candidates, with the notes moved to the note", () => {
    expect(cleanCandidates(["AI安全防护", "人工智能安全（攻撃への備えの意味）"], "zh-Hans")).toEqual({ candidates: ["AI安全防护", "人工智能安全"], annotations: ["攻撃への備えの意味"] });
    expect(cleanCandidates(["AIアラインメント（AIアライメント）"], "ja").candidates).toEqual(["AIアラインメント", "AIアライメント"]);
    expect(cleanCandidates(["a", "b"], undefined)).toEqual({ candidates: ["a", "b"], annotations: [] });
  });

  it("splits a pair written with a slash into two words to look for, and keeps the pair as one candidate", () => {
    expect(matchTermsOf("inner alignment / outer alignment", "en")).toEqual(["inner alignment", "outer alignment"]);
    expect(matchTermsOf("内部アラインメント／外部アラインメント", "ja")).toEqual(["内部アラインメント", "外部アラインメント"]);
    expect(matchTermsOf("AI safety", "en")).toEqual(["AI safety"]);
    expect(matchTermsOf("AGI (artificial general intelligence)", "en")).toEqual(["AGI", "artificial general intelligence"]);
  });

  it("looks for a Latin-script word as a whole word (a plural s is allowed) and for the others as a substring", () => {
    expect(termAppearsIn("value", "What is the value of this?")).toBe(true);
    expect(termAppearsIn("value", "We evaluate the model, a valuable one")).toBe(false);
    expect(termAppearsIn("value", "human values matter")).toBe(true);
    expect(termAppearsIn("compute", "more computers")).toBe(false);
    expect(termAppearsIn("compute", "a lot of Compute is needed")).toBe(true);
    expect(termAppearsIn("evals", "run the evals")).toBe(true);
    // Recognize the term even when adjacent to Japanese or Chinese characters.
    expect(termAppearsIn("RLHF", "整合性とRLHFの話。")).toBe(true);
    expect(termAppearsIn("AGI", "关于AGI的讨论")).toBe(true);
    expect(termAppearsIn("AI安全性", "AI安全性について")).toBe(true);
    expect(termAppearsIn("制御", "制御の問題")).toBe(true);
    expect(termAppearsIn("sûreté de l'IA", "La Sûreté de l'IA est")).toBe(true);
    expect(termAppearsIn("", "x")).toBe(false);
  });
});

describe("the glossary file", () => {
  it("reads the format, and reports every mistake with the words of the entry", () => {
    expect(parseGlossaryFile(FIXTURE).ok).toBe(true);
    const bad = (yaml: string) => {
      const res = parseGlossaryFile(yaml);
      return res.ok ? [] : res.errors;
    };
    expect(bad("format: other\nversion: 1\nentries: []")).not.toEqual([]);
    expect(bad("format: tomola-glossary\nversion: 2\nentries: []")).not.toEqual([]);
    expect(bad("not: [valid")[0]).toContain("not valid YAML");
    expect(bad('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"]}')).toEqual(["entry \"a\": terms needs at least two languages"]);
    expect(bad('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], xx: ["b"]}')[0]).toContain('unknown language "xx"');
    expect(bad('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: ["b"]}\n    needs_review: [fr]')).toEqual(["entry \"a / b\": needs_review names fr, which has no terms"]);
    expect(bad('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: [""]}')).not.toEqual([]);
    expect(bad('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: ["b"]}\n    surprise: 1')).not.toEqual([]);
    // Errors identify the term, not the item index.
    expect(bad('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: ["b"]}\n  - terms: {en: ["c"]}')).toEqual(['entry "c": terms needs at least two languages']);
  });

  it("makes a row for every direction among the languages of an entry, starting from the words of each language (English is not the pivot)", () => {
    const expanded = expandGlossaryFile(fixtureFile());
    expect(expanded.conflicts).toEqual([]);
    const rows = expanded.rows;
    const find = (term: string, lang: string, target: string) => rows.find((r) => r.term === term && r.lang === lang && r.targetLang === target);
    // reward hacking in en/ja/fr yields six directions. Find the French term without its note.
    expect(find("reward hacking", "en", "ja")).toMatchObject({ candidates: ["報酬ハッキング"], note: "原語のまま可。", keepOriginal: true, needsReview: false });
    expect(find("reward hacking", "en", "fr")).toMatchObject({ candidates: ["piratage de la récompense（英語のまま使われることも多い）"], keepOriginal: true, needsReview: true });
    expect(find("報酬ハッキング", "ja", "en")).toMatchObject({ candidates: ["reward hacking"], keepOriginal: false, needsReview: false });
    expect(find("報酬ハッキング", "ja", "fr")).toMatchObject({ needsReview: true });
    expect(find("piratage de la récompense", "fr", "ja")).toMatchObject({ candidates: ["報酬ハッキング"], keepOriginal: false, needsReview: false });
    expect(find("piratage de la récompense", "fr", "en")).toMatchObject({ candidates: ["reward hacking"] });
    // Paired terms produce a row per term while preserving the candidate pair.
    expect(find("inner alignment", "en", "ja")).toMatchObject({ candidates: ["内部アラインメント／外部アラインメント"] });
    expect(find("outer alignment", "en", "ja")).toMatchObject({ candidates: ["内部アラインメント／外部アラインメント"] });
    expect(find("外部アラインメント", "ja", "en")).toMatchObject({ candidates: ["inner alignment / outer alignment"] });
    // AGI in en/ja/zh-Hans: recognize abbreviations too; both Japanese candidates are terms.
    expect(find("AGI", "ja", "zh-Hans")).toMatchObject({ candidates: ["通用人工智能（AGI）"] });
    expect(find("汎用AI", "ja", "en")).toMatchObject({ candidates: ["AGI (artificial general intelligence)"] });
    expect(find("汎用人工知能", "ja", "zh-Hans")).toBeDefined();
    expect(find("通用人工智能", "zh-Hans", "ja")).toMatchObject({ candidates: ["汎用人工知能（AGI）", "汎用AI"] });
    // No directions for languages absent from the item.
    expect(rows.some((r) => r.lang === "zh-Hans" && r.targetLang === "fr")).toBe(false);
    expect(rows.every((r) => r.lang !== r.targetLang)).toBe(true);
  });

  it("keeps the earlier entry when two entries make the same row with different content, and says so; the same content makes one row", () => {
    const text = `format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["x"], ja: ["あ"]}\n  - terms: {en: ["x"], ja: ["い"]}\n`;
    const expanded = expandGlossaryFile(fixtureFile(text));
    expect(expanded.conflicts).toEqual(['the entries "x / あ" and "x / い" both make the row "x" (en → ja); the row of "x / あ" is kept']);
    expect(expanded.rows.find((r) => r.term === "x")).toMatchObject({ candidates: ["あ"] });
    // Other rows of the later item remain; rows starting from a Japanese term and rows targeting Japanese survive for both items.
    expect(expanded.rows.find((r) => r.term === "い")).toMatchObject({ lang: "ja", targetLang: "en", candidates: ["x"] });
    const same = expandGlossaryFile(fixtureFile(`format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["x"], ja: ["あ"]}\n  - terms: {en: ["x"], ja: ["あ"]}\n`));
    expect(same.conflicts).toEqual([]);
    expect(same.rows.filter((r) => r.term === "x")).toHaveLength(1);
  });
});

describe("importing into the database", () => {
  it("is idempotent: the second run writes nothing and the glossary version stays; a file with a new row only adds it, and does not rewrite the rows that exist", async () => {
    const db = await importDb();
    const expanded = expandGlossaryFile(fixtureFile());
    const first = await importRows(db, expanded.rows, { now: new Date("2026-10-05T00:00:00Z") });
    expect(first).toMatchObject({ created: expanded.rows.length, updated: 0, unchanged: 0, skipped: [], total: expanded.rows.length, versionBefore: null });
    expect(first.versionAfter).toMatch(/^[0-9a-f]{12}$/);
    const second = await importRows(db, expanded.rows, { now: new Date("2026-10-06T00:00:00Z") });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: expanded.rows.length, skipped: [], versionBefore: first.versionAfter, versionAfter: first.versionAfter });
    // updated_at stays unchanged; update only rows whose content changes.
    expect((await db.select().from(glossaryEntries)).every((r) => r.updatedAt.toISOString() === "2026-10-05T00:00:00.000Z")).toBe(true);
    // The updater is the --as operator. One import revision per created row; a second import adds no history.
    expect((await db.select().from(glossaryEntries)).every((r) => r.updatedBy === "op")).toBe(true);
    const revisions = await db.select().from(glossaryRevisions);
    expect(revisions).toHaveLength(expanded.rows.length);
    expect(revisions.every((r) => r.via === "import" && r.editorId === "op" && r.before === null && r.after !== null)).toBe(true);

    // When the file adds a candidate, insert new rows starting from it. List existing rows without overwriting them even if their content differs.
    const changed = fixtureFile(FIXTURE.replace('ja: ["報酬ハッキング"]', 'ja: ["報酬ハッキング", "報酬の悪用"]'));
    const exp3 = expandGlossaryFile(changed);
    const third = await importRows(db, exp3.rows, { now: new Date("2026-10-08T00:00:00Z") });
    expect(third.created).toBeGreaterThan(0);
    expect(third.updated).toBe(0);
    expect(third.skipped.length).toBeGreaterThan(0);
    expect(third.skipped.every((r) => r.reason === "differs")).toBe(true);
    expect((await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, "reward hacking") )).find((r) => r.targetLang === "ja")!.candidates).toEqual(["報酬ハッキング"]);
    // Keep rows absent from the file, including those added through the admin UI.
    await db.insert(glossaryEntries).values({ term: "手で足した語", lang: "ja", targetLang: "en", candidates: ["added"] });
    await importRows(db, exp3.rows);
    expect(await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, "手で足した語"))).toHaveLength(1);
  });

  it("--update rewrites the rows that differ and that nobody edited; a review mark alone does not change the glossary version, a candidate does", async () => {
    const db = await importDb();
    const base = await importRows(db, expandGlossaryFile(fixtureFile()).rows, { now: new Date("2026-10-05T00:00:00Z") });
    // Changing only needs-review (French is now checked) leaves the version unchanged because prompts are unaffected. Default import does not overwrite.
    const reviewed = expandGlossaryFile(fixtureFile(FIXTURE.replace("needs_review: [fr]", "needs_review: []"))).rows;
    const kept = await importRows(db, reviewed, { now: new Date("2026-10-06T00:00:00Z") });
    expect(kept).toMatchObject({ updated: 0 });
    expect(kept.skipped.length).toBeGreaterThan(0);
    expect((await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, "reward hacking"))).some((r) => r.needsReview)).toBe(true);
    const updated = await importRows(db, reviewed, { update: true, now: new Date("2026-10-07T00:00:00Z") });
    expect(updated.updated).toBeGreaterThan(0);
    expect(updated.skipped).toEqual([]);
    expect(updated.versionAfter).toBe(base.versionAfter);
    expect((await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, "reward hacking"))).every((r) => r.needsReview === false)).toBe(true);
    // Changing a candidate with --update updates the row and changes the version.
    const changed = expandGlossaryFile(fixtureFile(FIXTURE.replace('ja: ["報酬ハッキング"]', 'ja: ["報酬ハッキング", "報酬の悪用"]'))).rows;
    const fourth = await importRows(db, changed, { update: true, now: new Date("2026-10-08T00:00:00Z") });
    expect(fourth.updated).toBeGreaterThan(0);
    expect(fourth.created).toBeGreaterThan(0);
    expect(fourth.versionAfter).not.toBe(base.versionAfter);
  });

  it("never touches a row that a person edited, or puts a checked row back to needing review, unless --overwrite-edited is given", async () => {
    const db = await importDb();
    const rows = expandGlossaryFile(fixtureFile()).rows;
    await importRows(db, rows, { now: new Date("2026-10-05T00:00:00Z") });
    const target = (await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, "報酬ハッキング"))).find((r) => r.targetLang === "fr")!;
    expect(target.needsReview).toBe(true);
    // An operator corrected candidates and cleared needs-review in the admin UI; the latest revision is now admin.
    const human = await updateGlossaryEntry(db, operator, target.id, { term: target.term, candidates: ["piratage de la récompense (corrigé)"], note: target.note, keepOriginal: target.keepOriginal, needsReview: false }, { now: new Date("2026-10-06T00:00:00Z") });
    expect(human).toEqual({ ok: true, changed: true });
    const before = await db.select().from(glossaryEntries).where(eq(glossaryEntries.id, target.id));
    // Default reimport and --update both preserve human-edited rows, listing them with a reason.
    const plain = await importRows(db, rows);
    expect(plain.skipped).toEqual([{ term: "報酬ハッキング", lang: "ja", targetLang: "fr", reason: "edited" }]);
    const upd = await importRows(db, rows, { update: true });
    expect(upd.updated).toBe(0);
    expect(upd.skipped).toEqual([{ term: "報酬ハッキング", lang: "ja", targetLang: "fr", reason: "edited" }]);
    expect(await db.select().from(glossaryEntries).where(eq(glossaryEntries.id, target.id))).toEqual(before);
    // If an imported row was cleared of needs-review while its latest revision remains import, preserve it even with --update when the file would mark it for review again.
    const other = (await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, "reward hacking"))).find((r) => r.targetLang === "fr")!;
    await db.update(glossaryEntries).set({ needsReview: false }).where(eq(glossaryEntries.id, other.id));
    const reset = await importRows(db, rows, { update: true });
    expect(reset.skipped.find((r) => r.term === "reward hacking")).toEqual({ term: "reward hacking", lang: "en", targetLang: "fr", reason: "review_reset" });
    expect((await db.select().from(glossaryEntries).where(eq(glossaryEntries.id, other.id)))[0].needsReview).toBe(false);
    // --overwrite-edited restores both rows to file content.
    const all = await importRows(db, rows, { overwriteEdited: true });
    expect(all.skipped).toEqual([]);
    expect(all.updated).toBe(2);
    const [back] = await db.select().from(glossaryEntries).where(eq(glossaryEntries.id, target.id));
    expect(back).toMatchObject({ candidates: ["piratage de la récompense（英語のまま使われることも多い）"], needsReview: true, updatedBy: "op" });
    // Restoring file content also records an import revision, so import is now the latest source after the UI edit.
    expect((await db.select().from(glossaryRevisions).where(eq(glossaryRevisions.entryId, target.id))).map((r) => r.via)).toEqual(["import", "admin", "import"]);
    expect((await db.select().from(glossaryEntries).where(eq(glossaryEntries.id, other.id)))[0].needsReview).toBe(true);
  });

  it("--dry-run says what would change and writes nothing", async () => {
    const db = await importDb();
    const expanded = expandGlossaryFile(fixtureFile());
    const dry = await importRows(db, expanded.rows, { dryRun: true });
    expect(dry).toMatchObject({ created: expanded.rows.length, versionBefore: null, versionAfter: null });
    expect(await db.select().from(glossaryEntries)).toHaveLength(0);
  });

  it("needs_review is a column of its own that the glossary version does not read", async () => {
    const db = await importDb();
    await db.insert(glossaryEntries).values({ term: "a", lang: "ja", targetLang: "en", candidates: ["x"] });
    const [row] = await db.select().from(glossaryEntries);
    expect(row.needsReview).toBe(false);
    const before = await getGlossaryVersion(db);
    await db.update(glossaryEntries).set({ needsReview: true }).where(eq(glossaryEntries.id, row.id));
    expect(await getGlossaryVersion(db)).toBe(before);
  });
});

describe("the initial glossary (docs/drafts/glossary-initial.yaml)", () => {
  const load = () => {
    const parsed = parseGlossaryFile(fs.readFileSync(REAL, "utf8"));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.file;
  };

  // Read Markdown draft entries: per-item/per-language candidates separated by "、" except inside parentheses, plus notes.
  function readDraft() {
    const items: Array<{ heading: string; terms: Record<string, string[]>; note: string }> = [];
    const LANG: Record<string, Lang> = { 英: "en", 日: "ja", 仏: "fr", 簡: "zh-Hans", 繁: "zh-Hant" };
    let current: (typeof items)[number] | null = null;
    const split = (s: string) => {
      const out: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of s) {
        if (ch === "（" || ch === "(") depth++;
        if (ch === "）" || ch === ")") depth--;
        if (ch === "、" && depth === 0) {
          out.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      out.push(cur.trim());
      return out.filter(Boolean);
    };
    for (const line of fs.readFileSync(DRAFT, "utf8").split("\n")) {
      const h = /^(\d+)\. \*\*(.+)\*\*\s*$/.exec(line);
      if (h) {
        current = { heading: h[2], terms: {}, note: "" };
        items.push(current);
        continue;
      }
      const l = /^\s+- (英|日|仏|簡|繁|注記)：(.*)$/.exec(line);
      if (l && current) {
        if (l[1] === "注記") current.note = l[2].trim();
        else current.terms[LANG[l[1]]] = split(l[2].trim());
      }
    }
    for (const item of items) item.terms.ja ??= [item.heading];
    return items;
  }

  it("has exactly the content of the draft: every item with its words in the five languages and its note, unchanged", () => {
    const file = load();
    const draft = readDraft();
    expect(draft.length).toBe(33);
    expect(file.entries).toHaveLength(draft.length);
    draft.forEach((item, i) => {
      const entry = file.entries[i];
      // Identify entries by heading term, not number.
      expect(entry.terms, item.heading).toEqual(item.terms);
      expect(entry.note, item.heading).toBe(item.note);
    });
    // Preserve draft order, checked by headings. Previously paired entries are separate items.
    expect(file.entries.map((e) => e.terms.en?.[0])).toEqual(expect.arrayContaining(["inner alignment", "outer alignment", "frontier AI", "frontier model", "value", "values"]));
  });

  it("marks the Japanese and English words as confirmed and the French and Chinese words as needing review; only the items that say 原語のまま可 keep the English word", () => {
    const file = load();
    for (const entry of file.entries) {
      expect(entry.needs_review).toEqual(["fr", "zh-Hans", "zh-Hant"]);
      expect(Object.keys(entry.terms).sort()).toEqual(["en", "fr", "ja", "zh-Hans", "zh-Hant"]);
    }
    const keep = file.entries.filter((e) => e.keep_original.length > 0).map((e) => [e.terms.en?.[0], e.keep_original]);
    expect(keep).toEqual([["reward hacking", ["en"]], ["specification gaming", ["en"]], ["mesa-optimizer", ["en"]]]);
    expect(file.entries.filter((e) => e.note.includes("原語のまま可")).length).toBe(3);
  });

  it("makes a row for every direction among the five languages (20 directions per entry), none of them with English as the only starting point", { timeout: 30_000 }, async () => {
    const file = load();
    const expanded = expandGlossaryFile(file);
    const rows = expanded.rows;
    // The draft no longer has two different entries sharing the same term.
    expect(expanded.conflicts).toEqual([]);
    const directions = new Set(rows.map((r) => `${r.lang}>${r.targetLang}`));
    expect(directions.size).toBe(20);
    for (const from of ["ja", "en", "fr", "zh-Hans", "zh-Hant"]) for (const to of ["ja", "en", "fr", "zh-Hans", "zh-Hant"]) if (from !== to) expect(directions.has(`${from}>${to}`), `${from} → ${to}`).toBe(true);
    // Directions starting from Japanese terms in item B and those starting from French terms have equal weight.
    const find = (term: string, lang: string, target: string) => rows.find((r) => r.term === term && r.lang === lang && r.targetLang === target);
    expect(find("共生", "ja", "en")).toMatchObject({ candidates: ["coexistence", "symbiosis"], needsReview: false });
    expect(find("coexistence", "en", "ja")).toMatchObject({ candidates: ["共生"] });
    expect(find("symbiose", "fr", "zh-Hant")).toMatchObject({ candidates: ["共生", "共存"], needsReview: true });
    expect(find("AI对齐", "zh-Hans", "fr")).toMatchObject({ candidates: ["alignement de l'IA"] });
    expect(find("reward hacking", "en", "ja")).toMatchObject({ candidates: ["報酬ハッキング"], keepOriginal: true, needsReview: false });
    expect(find("報酬ハッキング", "ja", "en")).toMatchObject({ candidates: ["reward hacking"], keepOriginal: false });
    expect(find("inner alignment", "en", "zh-Hans")).toMatchObject({ candidates: ["内部对齐"] });
    expect(find("outer alignment", "en", "zh-Hans")).toMatchObject({ candidates: ["外部对齐"] });
    expect(find("価値観", "ja", "en")).toMatchObject({ candidates: ["values"] });
    expect(find("価値", "ja", "en")).toMatchObject({ candidates: ["value"] });
    expect(find("frontier model", "en", "ja")).toMatchObject({ candidates: ["フロンティアモデル"] });
    // Japanese and English targets are verified; French and Chinese targets need review.
    for (const r of rows) expect(r.needsReview, `${r.term} ${r.lang}→${r.targetLang}`).toBe(["fr", "zh-Hans", "zh-Hant"].includes(r.targetLang));
    // Count all directional rows per item; update this when the draft changes.
    expect(rows.length).toBe(856);
    expect(rows.filter((r) => r.needsReview).length).toBe(508);
    expect(rows.filter((r) => r.keepOriginal).length).toBe(12);

    // Insert into the database.
    const db = await importDb();
    const summary = await importRows(db, rows);
    expect(summary).toMatchObject({ created: rows.length, updated: 0, unchanged: 0 });
    expect((await db.select().from(glossaryEntries)).length).toBe(rows.length);
    // A second run does nothing.
    expect(await importRows(db, rows)).toMatchObject({ created: 0, updated: 0, unchanged: rows.length, versionAfter: summary.versionAfter });
  });

  it("round-trips: import, export and compare gives the same file apart from the order of the entries (and the comments)", { timeout: 30_000 }, async () => {
    const file = load();
    const expanded = expandGlossaryFile(file);
    const db = await importDb();
    await importRows(db, expanded.rows);
    const exported = await exportGlossary(db);
    expect(canonicalGlossaryJson(exported)).toBe(canonicalGlossaryJson(file));
    expect(exported.entries).toHaveLength(33);
    // Exported YAML is importable and reads back identically.
    const text = serializeGlossaryFile(exported);
    expect(text).toContain('format: "tomola-glossary"');
    expect(text).toContain('en: ["AI alignment"]');
    const reparsed = parseGlossaryFile(text);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(canonicalGlossaryJson(reparsed.file)).toBe(canonicalGlossaryJson(file));
    // Reimporting exported content changes nothing.
    const again = expandGlossaryFile(reparsed.ok ? reparsed.file : file);
    expect(await importRows(db, again.rows)).toMatchObject({ created: 0, updated: 0 });
    // Reconstructing from rows gives the same result, independent of import order.
    const rows = (await db.select().from(glossaryEntries)).map((r) => ({ term: r.term, lang: r.lang as Lang, targetLang: r.targetLang as Lang, candidates: r.candidates, note: r.note, keepOriginal: r.keepOriginal, needsReview: r.needsReview }));
    expect(canonicalGlossaryJson(buildGlossaryFile([...rows].reverse()))).toBe(canonicalGlossaryJson(file));
  });

  it("is passed to the translation prompt as recommended translations, clean of the notes in parentheses", { timeout: 30_000 }, async () => {
    const file = load();
    const expanded = expandGlossaryFile(file);
    const db = await importDb();
    await importRows(db, expanded.rows);
    // en → zh-Hans: preserve candidate order from the draft, preferred candidate first.
    const enZh = matchGlossary(await loadGlossary(db, "en", "zh-Hans"), "We study AI security and AI alignment.");
    const security = enZh.find((h) => h.term === "AI security")!;
    expect(security.candidates).toEqual(["AI安全防护", "人工智能安全防护"]);
    expect(security.note).toContain("AI safety（事故や意図しない害を防ぐこと）と取り違えない");
    expect(enZh.find((h) => h.term === "AI alignment")!.candidates).toEqual(["AI对齐", "人工智能对齐"]);
    // en → ja: put "アライメント" first, matching the draft.
    expect(matchGlossary(await loadGlossary(db, "en", "ja"), "AI alignment is hard")[0].candidates).toEqual(["AIアライメント", "AIアラインメント"]);
    // en → fr: parenthetical explanations become notes, not candidates.
    const reward = matchGlossary(await loadGlossary(db, "en", "fr"), "Reward hacking is common.")[0];
    expect(reward.candidates).toEqual(["piratage de la récompense"]);
    expect(reward.note).toContain("英語のまま使われることも多い");
    // en → fr: keep_original entries retain the source term.
    const keep = matchGlossary(await loadGlossary(db, "en", "ja"), "Reward hacking and specification gaming").map((h) => [h.term, h.keepOriginal]);
    expect(keep).toEqual([["reward hacking", true], ["specification gaming", true]]);
    // keep_original does not force source-only wording: candidates also enter the prompt, allowing either the original or a candidate.
    const keepPrompt = translationUserPrompt({ text: "Reward hacking and specification gaming", from: "en", to: "ja", glossary: matchGlossary(await loadGlossary(db, "en", "ja"), "Reward hacking and specification gaming") }, "n");
    expect(keepPrompt).toContain('- "reward hacking": may be kept as written, or -> "報酬ハッキング" (原語のまま可。)');
    expect(keepPrompt).toContain('- "specification gaming": may be kept as written, or -> "仕様ゲーミング"');
    expect(keepPrompt).not.toContain('"reward hacking": keep as written');
    // ja → en: starting from Japanese terms.
    expect(matchGlossary(await loadGlossary(db, "ja", "en"), "AI安全性と共生について").map((h) => h.term).sort()).toEqual(["AI安全性", "共生", "安全性"]);
    // Prompt lines.
    const prompt = translationUserPrompt({ text: "AI security", from: "en", to: "zh-Hans", glossary: [security] }, "n");
    expect(prompt).toContain('- "AI security" -> "AI安全防护" or "人工智能安全防护"');
    const rewardPrompt = translationUserPrompt({ text: "Reward hacking", from: "en", to: "fr", glossary: [reward] }, "n");
    expect(rewardPrompt).not.toContain("récompense（");
  });

  it("is used by the translation job: the matching rows reach the engine and the version is stored on the translation", { timeout: 30_000 }, async () => {
    const file = load();
    const expanded = expandGlossaryFile(file);
    const db = await importDb();
    await addMember(db, "u1", "hana");
    await importRows(db, expanded.rows);
    const made = await createTopic(db, "u1", { lang: "ja", title: "報酬ハッキング", body: "報酬ハッキングと共生の話。" });
    if (!made.ok) throw new Error("topic failed");
    const seen: TranslationRequest[] = [];
    const base = createFakeEngine();
    const engine = { ...base, translate: async (req: TranslationRequest) => (seen.push(req), base.translate(req)) };
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null }, env: {} } }), { now: new Date("2026-10-05T00:00:00Z"), limit: 500, logger: { error() {}, warn() {} } });
    const toEn = seen.find((r) => r.to === "en" && r.text.startsWith("報酬ハッキングと"))!;
    expect(Object.fromEntries(toEn.glossary!.map((h) => [h.term, h.candidates]))).toEqual({ 報酬ハッキング: ["reward hacking"], 共生: ["coexistence", "symbiosis"] });
    const version = await getGlossaryVersion(db);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("pnpm glossary:import", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "glossary-import-"));
  afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, NODE_ENV: "test", PGLITE_DATA_DIR: path.join(dir, "pglite"), OPERATOR_EMAILS: "op@example.com" };
  let db: Db | undefined;
  const openDb = vi.fn(async () => db ??= await createTestDb());
  const run = (...args: string[]) => captureCli(output => runGlossaryImport(args, openDb, output));
  const exportRun = () => captureCli(output => runGlossaryExport([], openDb, output));
  const seed = async (id: string, email: string, handle: string) => {
    await addMember(await openDb(), id, handle, { email });
    return { status: 0 };
  };

  it("imports the initial glossary, says nothing changed the second time, and --dry-run writes nothing; mistakes exit 1", { timeout: 300_000 }, async () => {
    const bad = (await run());
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("usage: pnpm glossary:import");
    // --as is required; never create a revision without an actor.
    const noAs = (await run(REAL));
    expect(noAs.status).toBe(1);
    expect(noAs.stderr).toContain("--as <operator handle> is required");
    expect((await run(REAL, "--as")).stderr).toContain("--as needs a value");
    expect((await run(REAL, "--as", "opal", "--bogus")).stderr).toContain("unknown option: --bogus");
    const missing = (await run(path.join(dir, "missing.yaml"), "--as", "opal"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("cannot read");
    fs.writeFileSync(path.join(dir, "broken.yaml"), "format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: [\"a\"]}\n");
    const invalid = (await run(path.join(dir, "broken.yaml"), "--as", "opal"));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('entry "a": terms needs at least two languages');
    // Invalid arguments and files must fail before opening any database.
    expect(openDb).not.toHaveBeenCalled();

    vi.stubEnv("OPERATOR_EMAILS", env.OPERATOR_EMAILS);
    // Missing members and non-operators produce exit code 1 with no writes.
    const nobody = (await run(REAL, "--as", "opal"));
    expect(nobody.status).toBe(1);
    expect(nobody.stderr).toContain("there is no member with that handle");
    expect((await seed("op", "op@example.com", "opal")).status).toBe(0);
    expect((await seed("u2", "u2@example.com", "hana")).status).toBe(0);
    const member = (await run(REAL, "--as", "hana"));
    expect(member.status).toBe(1);
    expect(member.stderr).toContain("not an operator");
    expect((await exportRun()).stdout).not.toContain("rows:");

    const dry = (await run(REAL, "--as", "opal", "--dry-run"));
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stderr).not.toContain("warning");
    expect(dry.stdout).toMatch(/33 entries make \d+ rows: \d+ would be created, 0 would be updated, 0 unchanged, 0 existing rows left as they are \(dry run: nothing was written\)/);
    const first = (await run(REAL, "--as", "@Opal"));
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/33 entries make (\d+) rows: \1 created, 0 updated, 0 unchanged, 0 existing rows/);
    expect(first.stdout).toMatch(/glossary version: \(empty\) -> [0-9a-f]{12}\n/);
    const second = (await run(REAL, "--as", "opal"));
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/0 created, 0 updated, \d+ unchanged/);
    expect(second.stdout).toMatch(/glossary version: ([0-9a-f]{12}) -> \1 \(unchanged\)/);

    // An invalid proposal reference exits without writes.
    const badProposal = (await run(REAL, "--as", "opal", "--proposal", "999999"));
    expect(badProposal.status).toBe(1);
    expect(badProposal.stderr).toContain("is not a topic of this site");

    // A changed file adds candidates. By default, insert only new rows and list existing differences without overwriting; --update overwrites.
    const changed = path.join(dir, "changed.yaml");
    const source = fs.readFileSync(REAL, "utf8");
    expect(source).toContain('ja: ["報酬ハッキング"]');
    fs.writeFileSync(changed, source.replace('ja: ["報酬ハッキング"]', 'ja: ["報酬ハッキング", "報酬の悪用"]'));
    const plain = (await run(changed, "--as", "opal"));
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toMatch(/[1-9]\d* created, 0 updated, \d+ unchanged, [1-9]\d* existing rows left as they are/);
    expect(plain.stdout).toContain('"reward hacking" (en -> ja): differs from the file');
    expect(plain.stdout).toContain("the database is the source of truth: --update rewrites");
    const again = (await run(changed, "--as", "opal"));
    expect(again.stdout).toMatch(/0 created, 0 updated, \d+ unchanged, [1-9]\d* existing rows left as they are/);
    const updated = (await run(changed, "--as=opal", "--update"));
    expect(updated.status, updated.stderr).toBe(0);
    expect(updated.stdout).toMatch(/0 created, [1-9]\d* updated, \d+ unchanged, 0 existing rows left as they are/);
    expect(updated.stdout).not.toContain("rows that exist and were not changed");
    expect((await run(changed, "--as", "opal", "--overwrite-edited")).stdout).toMatch(/0 created, 0 updated/);
  });
});

it("glossary import CLI rejects missing and unknown arguments with exit 1 before opening the database", { timeout: 90_000 }, () => {
  for (const args of [[], [REAL, "--as", "opal", "--bogus"]]) {
    const result = spawnSync(path.join(root, "node_modules/.bin/tsx"), ["scripts/import-glossary.ts", ...args], { env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: pnpm glossary:import");
  }
});
