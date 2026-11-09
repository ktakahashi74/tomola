import { spawnSync } from "node:child_process";
import { runGlossaryImport } from "../scripts/import-glossary";
import { runGlossaryExport } from "../scripts/export-glossary";
import { captureCli } from "./helpers/cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { glossaryEntries, glossaryRevisions } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import {
  buildGlossaryExport,
  expandGlossaryFile,
  GlossaryImportError,
  glossaryExportFile,
  importGlossaryRows,
  parseGlossaryFile,
  serializeGlossaryFile,
  type GlossaryRowData,
} from "~/lib/glossary-io.server";
import { createGlossaryEntry, deleteGlossaryEntry, loadAllGlossary, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { createApiToken } from "~/lib/tokens.server";
import { getGlossaryVersion } from "~/lib/translations.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Glossary export (pnpm glossary:export and /glossary.yaml): all active rows in a deterministic row-oriented format matching import, supporting round trips.

const root = path.resolve(import.meta.dirname, "..");
const REAL = path.join(root, "docs/drafts/glossary-initial.yaml");
const op: GlossaryActor = { userId: "op", scope: { operator: true, langs: [] } };
const t = (n: number) => new Date(Date.UTC(2026, 9, 5, 0, n));

async function freshDb(): Promise<Db> {
  const db = await createTestDb();
  await addMember(db, "op", "opal");
  return db;
}

const rowsOf = async (db: Db): Promise<GlossaryRowData[]> =>
  (await loadAllGlossary(db))
    .map((r) => ({ term: r.term, lang: r.lang as GlossaryRowData["lang"], targetLang: r.targetLang as GlossaryRowData["targetLang"], candidates: r.candidates, note: r.note, keepOriginal: r.keepOriginal, needsReview: r.needsReview }))
    .sort((a, b) => JSON.stringify([a.term, a.lang, a.targetLang]).localeCompare(JSON.stringify([b.term, b.lang, b.targetLang])));

// A glossary whose rows changed independently after import: one-way rows, different candidates and notes, nine languages, UI-deleted rows and human-edited rows.
async function messyGlossary(db: Db, actor: GlossaryActor = op) {
  const make = async (input: Parameters<typeof createGlossaryEntry>[2], now: Date) => {
    const res = await createGlossaryEntry(db, actor, input, { now });
    if (!res.ok) throw new Error(`create failed: ${res.error}`);
    return res.id;
  };
  await make({ term: "alignment", lang: "en", targetLang: "ja", candidates: "アラインメント\nアライメント", note: "AI safety" }, t(1));
  // No reverse row; one direction only.
  await make({ term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment", keepOriginal: true }, t(2));
  await make({ term: "alignment", lang: "en", targetLang: "fr", candidates: "alignement", needsReview: true }, t(3));
  await make({ term: "alignment", lang: "en", targetLang: "de", candidates: "Ausrichtung\nAlignment" }, t(4));
  await make({ term: "alignment", lang: "en", targetLang: "ko", candidates: "정렬" }, t(5));
  await make({ term: "alignment", lang: "en", targetLang: "th", candidates: "การจัดแนว" }, t(5));
  await make({ term: "alignment", lang: "en", targetLang: "vi", candidates: "căn chỉnh" }, t(5));
  await make({ term: "alignment", lang: "en", targetLang: "zh-Hans", candidates: "对齐" }, t(5));
  await make({ term: "alignment", lang: "en", targetLang: "zh-Hant", candidates: "對齊\n校準" }, t(5));
  // Empty candidates with newlines, quotes and symbols in the note.
  await make({ term: 'say "hi": #1', lang: "en", targetLang: "ja", candidates: "", note: 'a "quoted" note\nsecond line: - [x] {y} \\ done' }, t(6));
  await make({ term: "  spaced  ", lang: "en", targetLang: "ja", candidates: "x" }, t(6));
  // A human-edited row and a UI-deleted row.
  const edited = await make({ term: "corrigibility", lang: "en", targetLang: "ja", candidates: "修正可能性" }, t(7));
  expect(await updateGlossaryEntry(db, actor, edited, { term: "corrigibility", candidates: "修正可能性\nコリジビリティ", note: "n" }, { now: t(8) })).toEqual({ ok: true, changed: true });
  const gone = await make({ term: "gone", lang: "en", targetLang: "ja", candidates: "消えた" }, t(9));
  expect(await deleteGlossaryEntry(db, actor, gone, { now: t(10) })).toEqual({ ok: true });
}

describe("the export file", () => {
  it("writes the active rows only (the deleted ones are left out), all nine languages, one row per line, in the order of the glossary version, with no time, editor or history in it", async () => {
    const db = await freshDb();
    await messyGlossary(db);
    const text = await buildGlossaryExport(db);
    const parsed = parseGlossaryFile(text);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.file.entries).toEqual([]);
    expect(parsed.file.rows).toHaveLength((await loadAllGlossary(db)).length);
    expect(text).not.toContain("gone");
    expect(new Set(parsed.file.rows.flatMap((r) => [r.lang, r.targetLang]))).toEqual(new Set(["en", "ja", "fr", "de", "ko", "th", "vi", "zh-Hans", "zh-Hant"]));
    // Order by term, source language, then target language, matching glossary version ordering.
    const keys = parsed.file.rows.map((r) => [r.term, r.lang, r.targetLang]);
    expect(keys).toEqual([...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)));
    // One flow-style object per line ({term: ...}); omit timestamps, updater and history.
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("  - {")).length).toBe(parsed.file.rows.length);
    expect(lines.filter((l) => l.startsWith("  - {term: ")).length).toBeGreaterThanOrEqual(parsed.file.rows.length - 1);
    expect(lines[0]).toBe('format: "tomola-glossary"');
    expect(text).not.toMatch(/updated|created|editor|history|opal|operator|202\d-\d\d/i);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is the same bytes for the same content, whatever the order the rows were made in, who made them and when", async () => {
    const a = await freshDb();
    const b = await freshDb();
    await addMember(b, "other", "other");
    await messyGlossary(a);
    // b creates identical content in a different order, by a different actor, at a different time, without adding deleted rows.
    const rows = await rowsOf(a);
    for (const r of [...rows].reverse()) {
      const res = await createGlossaryEntry(b, { userId: "other", scope: { operator: true, langs: [] } }, { term: r.term, lang: r.lang, targetLang: r.targetLang, candidates: r.candidates, note: r.note, keepOriginal: r.keepOriginal, needsReview: r.needsReview }, { now: t(30 + r.term.length) });
      expect(res.ok).toBe(true);
    }
    expect(await buildGlossaryExport(b)).toBe(await buildGlossaryExport(a));
    expect(await getGlossaryVersion(b)).toBe(await getGlossaryVersion(a));
    // Re-adding a deleted row with identical content restores the same exported file.
    const before = await buildGlossaryExport(a);
    const [gone] = (await a.select().from(glossaryEntries)).filter((r) => r.term === "gone");
    expect(await createGlossaryEntry(a, op, { term: "gone", lang: "en", targetLang: "ja", candidates: "消えた" }, { now: t(40) })).toEqual({ ok: true, id: gone.id, revived: true });
    expect(await buildGlossaryExport(a)).not.toBe(before);
    await deleteGlossaryEntry(a, op, gone.id, { now: t(41) });
    expect(await buildGlossaryExport(a)).toBe(before);
  });

  it("an empty glossary is a valid file that imports as nothing", async () => {
    const db = await freshDb();
    const text = await buildGlossaryExport(db);
    expect(text).toBe('format: "tomola-glossary"\nversion: 1\nentries: []\n');
    const parsed = parseGlossaryFile(text);
    expect(parsed.ok && parsed.file.rows).toEqual([]);
  });
});

describe("the round trip with the import", () => {
  it("(1) imports into an empty database to the same rows and the same glossary version; (2) importing it again changes nothing and adds no history", async () => {
    const source = await freshDb();
    await messyGlossary(source);
    const text = await buildGlossaryExport(source);
    const parsed = parseGlossaryFile(text);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const expanded = expandGlossaryFile(parsed.file);
    expect(expanded.conflicts).toEqual([]);

    const target = await freshDb();
    const first = await importGlossaryRows(target, expanded.rows, { actor: op, now: t(50) });
    expect(first).toMatchObject({ created: expanded.rows.length, updated: 0, unchanged: 0, skipped: [], versionBefore: null });
    expect(first.versionAfter).toBe(await getGlossaryVersion(source));
    expect(await rowsOf(target)).toEqual(await rowsOf(source));
    // Export, import, export: identical file.
    expect(await buildGlossaryExport(target)).toBe(text);

    const revisionsBefore = (await target.select().from(glossaryRevisions)).length;
    const again = await importGlossaryRows(target, expanded.rows, { actor: op, now: t(60) });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: expanded.rows.length, skipped: [], versionAfter: first.versionAfter });
    expect((await target.select().from(glossaryRevisions)).length).toBe(revisionsBefore);
    // Importing the file into the original database changes nothing.
    const onSource = await importGlossaryRows(source, expanded.rows, { actor: op, now: t(70) });
    expect(onSource).toMatchObject({ created: 0, updated: 0, skipped: [] });
  });

  it("(3) the initial glossary: import, export, import into another database gives the same version (and the same rows)", { timeout: 60_000 }, async () => {
    const parsed = parseGlossaryFile(fs.readFileSync(REAL, "utf8"));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const first = await freshDb();
    await importGlossaryRows(first, expandGlossaryFile(parsed.file).rows, { actor: op });
    const text = await buildGlossaryExport(first);
    const second = await freshDb();
    const reparsed = parseGlossaryFile(text);
    if (!reparsed.ok) throw new Error(reparsed.errors.join("; "));
    await importGlossaryRows(second, expandGlossaryFile(reparsed.file).rows, { actor: op });
    expect(await getGlossaryVersion(second)).toBe(await getGlossaryVersion(first));
    expect(await rowsOf(second)).toEqual(await rowsOf(first));
    expect((await rowsOf(first)).length).toBe(856);
    expect(await buildGlossaryExport(second)).toBe(text);
  });

  it("the row-per-line form is read together with the grouped form; a row that is written wins over the same row made by an entry", () => {
    const parsed = parseGlossaryFile(`format: tomola-glossary
version: 1
entries:
  - terms: {en: ["x"], ja: ["あ"]}
    note: "from the entry"
rows:
  - {term: "x", lang: "en", target_lang: "ja", candidates: ["い"], note: "written", keep_original: true, needs_review: true}
  - {term: "y", lang: "fr", target_lang: "de"}
`);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const rows = expandGlossaryFile(parsed.file).rows;
    expect(rows.find((r) => r.term === "x" && r.lang === "en")).toEqual({ term: "x", lang: "en", targetLang: "ja", candidates: ["い"], note: "written", keepOriginal: true, needsReview: true });
    // The file says two things about one row: the expansion reports it (the CLI prints it as a warning); the same content says nothing
    const expanded = expandGlossaryFile(parsed.file);
    expect(expanded.overrides).toEqual(['the row "x" (en → ja) is written in rows: and also made by the entry "x / あ" with other content; the row in rows: is used']);
    const same = parseGlossaryFile('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["x"], ja: ["あ"]}\nrows:\n  - {term: "x", lang: "en", target_lang: "ja", candidates: ["あ"]}\n');
    expect(same.ok && expandGlossaryFile(same.file).overrides).toEqual([]);
    // Other directional rows produced by grouped syntax remain unchanged.
    expect(rows.find((r) => r.term === "あ" && r.lang === "ja")).toMatchObject({ candidates: ["x"], note: "from the entry" });
    // Omitted fields use defaults: empty candidates and note, both flags false.
    expect(rows.find((r) => r.term === "y")).toEqual({ term: "y", lang: "fr", targetLang: "de", candidates: [], note: "", keepOriginal: false, needsReview: false });
  });

  it("reports every mistake in the rows, with the row number and the word", () => {
    const bad = (rows: string) => {
      const res = parseGlossaryFile(`format: tomola-glossary\nversion: 1\nrows:\n${rows}`);
      return res.ok ? [] : res.errors;
    };
    expect(bad('  - {term: "a", lang: "xx", target_lang: "ja"}')).toEqual(['row 1 ("a"): unknown language "xx" in lang (one of ja, en, fr, de, zh-Hant, zh-Hans, ko, th, vi)']);
    expect(bad('  - {term: "a", lang: "ja", target_lang: "ja"}')).toEqual(['row 1 ("a"): lang and target_lang are the same (ja)']);
    expect(bad('  - {term: " ", lang: "en", target_lang: "ja"}')).toEqual(['row 1 (" "): term must be 1 to 200 characters']);
    expect(bad('  - {term: "a", lang: "en", target_lang: "ja"}\n  - {term: "a", lang: "en", target_lang: "ja", note: "dup"}')).toEqual(['row 2 ("a"): the row "a" (en → ja) is written twice']);
    // A term and a candidate are one line (no line break, tab, other control character or line separator); the error names the row
    expect(bad('  - {term: "a\\nb", lang: "en", target_lang: "ja"}')).toEqual(['row 1 ("a\nb"): term must be a single line (no line break, tab or other control character)']);
    expect(bad('  - {term: "a\\tb", lang: "en", target_lang: "ja"}')).toEqual(['row 1 ("a\tb"): term must be a single line (no line break, tab or other control character)']);
    expect(bad('  - {term: "a\\u2028b", lang: "en", target_lang: "ja"}')).toHaveLength(1);
    expect(bad('  - {term: "ok", lang: "en", target_lang: "ja", candidates: ["fine", "x\\ny"]}')).toEqual(['row 1 ("ok"): candidate "x\\ny" must be a single line (no line break, tab or other control character)']);
    expect(bad('  - {term: "ok", lang: "en", target_lang: "ja", candidates: ["a\\r"]}')).toEqual([]);
    expect(bad('  - {term: "ok", lang: "en", target_lang: "ja", candidates: ["a\\rb"]}')).toHaveLength(1);
    expect(bad('  - {term: "ok", lang: "en", target_lang: "ja", note: "a\\nb"}')).toEqual([]);
    // The grouped form too (the words of an entry)
    const grouped = parseGlossaryFile('format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a\\nb"], ja: ["x"]}\n');
    expect(grouped.ok).toBe(false);
    expect(!grouped.ok && grouped.errors.join(" ")).toContain("must be a single line");
    expect(bad('  - {term: "a", lang: "en", target_lang: "ja", surprise: 1}')).not.toEqual([]);
    expect(bad('  - {term: "a", lang: "en", target_lang: "ja", keep_original: "yes"}')).not.toEqual([]);
    expect(bad('  - {term: "a", lang: "en", target_lang: "ja", candidates: [""]}')).not.toEqual([]);
  });

  it("serializes rows that survive the quoting: quotes, newlines, colons, braces, backslashes and leading spaces round-trip exactly", () => {
    const rows: GlossaryRowData[] = [
      { term: 'say "hi": #1 {x}', lang: "en", targetLang: "ja", candidates: ["a, b", "[c]", "- d", "e: f", "\\g", "日本語"], note: 'a "quoted" note\nsecond line: - [x] \\ done\ttab', keepOriginal: true, needsReview: false },
      { term: "null", lang: "en", targetLang: "fr", candidates: ["true", "123", "~", "no"], note: "", keepOriginal: false, needsReview: true },
    ];
    const text = serializeGlossaryFile(glossaryExportFile(rows));
    const parsed = parseGlossaryFile(text);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.file.rows).toEqual([...rows].sort((a, b) => (a.term < b.term ? -1 : 1)));
  });
});

describe("the history that an import leaves", () => {
  it("records the operator as the editor, via import, and the proposal post on every change; a bad proposal stops the import before anything is written", async () => {
    const db = await freshDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "訳語", body: "b", asksStance: true });
    if (!topic.ok) throw new Error("topic failed");
    const rows = expandGlossaryFile(parseGlossaryFileOrThrow(`format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: ["あ"]}\n`)).rows;
    await expect(importGlossaryRows(db, rows, { actor: op, proposal: "99999" })).rejects.toBeInstanceOf(GlossaryImportError);
    expect(await db.select().from(glossaryEntries)).toHaveLength(0);
    expect(await importGlossaryRows(db, rows, { actor: op, proposal: `/t/${topic.id}`, now: t(1) })).toMatchObject({ created: 2 });
    const revs = await db.select().from(glossaryRevisions).orderBy(asc(glossaryRevisions.id));
    expect(revs).toHaveLength(2);
    expect(revs.every((r) => r.editorId === "op" && r.via === "import" && r.proposalEntryId === topic.id && r.before === null)).toBe(true);
    // --update changes also create history; identical-content rows do not.
    const changed = expandGlossaryFile(parseGlossaryFileOrThrow(`format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: ["あ", "ア"]}\n`)).rows;
    const upd = await importGlossaryRows(db, changed, { actor: op, update: true, now: t(2) });
    expect(upd).toMatchObject({ updated: 1, unchanged: 1, created: 1 });
    expect((await db.select().from(glossaryRevisions)).length).toBe(2 + 1 + 1);
    // An invalid import leaves no partial writes; the entire import is one transaction.
    const bad = [...rows, { term: "z".repeat(300), lang: "en", targetLang: "ja", candidates: [], note: "", keepOriginal: false, needsReview: false } as GlossaryRowData];
    const before = (await db.select().from(glossaryRevisions)).length;
    await expect(importGlossaryRows(db, [{ term: "fresh", lang: "en", targetLang: "ja", candidates: ["x"], note: "", keepOriginal: false, needsReview: false }, ...bad], { actor: op })).rejects.toBeInstanceOf(GlossaryImportError);
    expect((await db.select().from(glossaryRevisions)).length).toBe(before);
    expect((await db.select().from(glossaryEntries)).some((r) => r.term === "fresh")).toBe(false);
  });

  it("does not bring back a row that a person deleted in the admin page (unless --overwrite-edited), and never deletes a row itself", async () => {
    const db = await freshDb();
    const rows = expandGlossaryFile(parseGlossaryFileOrThrow(`format: tomola-glossary\nversion: 1\nentries:\n  - terms: {en: ["a"], ja: ["あ"]}\n`)).rows;
    await importGlossaryRows(db, rows, { actor: op, now: t(1) });
    const [row] = (await db.select().from(glossaryEntries)).filter((r) => r.term === "a");
    expect(await deleteGlossaryEntry(db, op, row.id, { now: t(2) })).toEqual({ ok: true });
    const plain = await importGlossaryRows(db, rows, { actor: op, update: true, now: t(3) });
    expect(plain).toMatchObject({ created: 0, updated: 0, unchanged: 1, skipped: [{ term: "a", lang: "en", targetLang: "ja", reason: "edited" }] });
    expect((await getGlossaryVersion(db))).toBe((await importGlossaryRows(db, rows, { actor: op, dryRun: true })).versionAfter);
    expect((await db.select().from(glossaryEntries)).find((r) => r.id === row.id)?.deletedAt).not.toBeNull();
    // --overwrite-edited restores the same row and continues its history.
    const forced = await importGlossaryRows(db, rows, { actor: op, overwriteEdited: true, now: t(4) });
    expect(forced).toMatchObject({ created: 1, skipped: [] });
    expect((await db.select().from(glossaryEntries)).find((r) => r.id === row.id)?.deletedAt).toBeNull();
    expect((await db.select().from(glossaryRevisions)).filter((r) => r.entryId === row.id).map((r) => [r.before === null, r.after === null, r.via])).toEqual([[true, false, "import"], [false, true, "admin"], [true, false, "import"]]);
    // Do not delete rows absent from the file.
    const fewer = rows.filter((r) => r.lang === "en");
    await importGlossaryRows(db, fewer, { actor: op, now: t(5) });
    expect((await db.select().from(glossaryEntries)).filter((r) => r.deletedAt === null)).toHaveLength(2);
  });
});

function parseGlossaryFileOrThrow(text: string) {
  const parsed = parseGlossaryFile(text);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.file;
}

// ---- /glossary.yaml ----

describe("/glossary.yaml", () => {
  let h: RouteHarness;
  const saved = process.env.OPERATOR_EMAILS;
  const get = async (init: { as?: string; headers?: Record<string, string>; method?: string; query?: string } = {}) => {
    const req = h.request(`/glossary.yaml${init.query ?? ""}`, { as: init.as, headers: init.headers });
    return (await (await import("~/routes/glossary-export")).loader(h.args(init.method ? new Request(req, { method: init.method }) : req))) as Awaited<Promise<Response>>;
  };

  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("aki");
    await h.signIn("susp");
    await messyGlossary(h.db, { userId: h.ids.aki, scope: { operator: true, langs: [] } });
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
  });

  it("is a download of the same text as pnpm glossary:export, for the session and a read token; a visitor gets 401 and a draft token 403", async () => {
    expect((await get()).status).toBe(401);
    const res = await get({ as: "aki" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="tomola-glossary-\d{4}-\d{2}-\d{2}\.yaml"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await res.text();
    expect(text).toBe(await buildGlossaryExport(h.db));
    // The file says nothing about people: no user id, no e-mail address, no handle
    for (const [handle, userId] of Object.entries(h.ids)) {
      expect(text).not.toContain(userId);
      expect(text).not.toContain(`${handle}@example.com`);
    }
    expect(text).not.toMatch(/@example\.com|@aki|@susp|editor|user_id|updated_by/i);
    const read = await createApiToken(h.db, h.ids.aki, { name: "r", kind: "read" });
    const draft = await createApiToken(h.db, h.ids.aki, { name: "d", kind: "draft" });
    if (!read.ok || !draft.ok) throw new Error("token failed");
    expect((await get({ headers: { authorization: `Bearer ${read.token}` } })).status).toBe(200);
    expect((await get({ headers: { authorization: `Bearer ${draft.token}` } })).status).toBe(403);
    // Ignore filter parameters; always export everything.
    expect(await (await get({ as: "aki", query: "?to=ja&from=en&deleted=1&page=2" })).text()).toBe(text);
    // Can be imported.
    expect(parseGlossaryFile(text).ok).toBe(true);
  });

  it("answers only GET and HEAD (405 for anything else); HEAD has the headers and no body", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get({ as: "aki", method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    const head = await get({ as: "aki", method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-disposition")).toContain("attachment");
    expect(await head.text()).toBe("");
    expect((await get({ as: "susp" })).status).toBe(200);
  });
});

// ---- pnpm glossary:export ----

describe("pnpm glossary:export", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "glossary-export-"));
  afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, NODE_ENV: "test", PGLITE_DATA_DIR: path.join(dir, "pglite"), OPERATOR_EMAILS: "op@example.com" };
  let db: Db;
  const openDb = async () => db;
  const exportRun = (...args: string[]) => captureCli(output => runGlossaryExport(args, openDb, output));
  const importRun = (...args: string[]) => captureCli(output => runGlossaryImport(args, openDb, output));

  it("writes to the standard output, or to a file with --out; it is what the import reads back; mistakes exit 1", { timeout: 300_000 }, async () => {
    const bad = (await exportRun("--bogus"));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("usage: pnpm glossary:export");
    expect((await exportRun("--out")).status).toBe(1);
    db = await createTestDb();
    // Empty database.
    const empty = (await exportRun());
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toBe('format: "tomola-glossary"\nversion: 1\nentries: []\n');

    vi.stubEnv("OPERATOR_EMAILS", env.OPERATOR_EMAILS);
    await addMember(db, "op", "opal", { email: env.OPERATOR_EMAILS });
    const imported = (await importRun(REAL, "--as", "opal"));
    expect(imported.status, imported.stderr).toBe(0);
    const out = (await exportRun());
    expect(out.status, out.stderr).toBe(0);
    const file = path.join(dir, "glossary.yaml");
    const written = (await exportRun("--out", file));
    expect(written.status, written.stderr).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(out.stdout);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect((await exportRun(`--out=${path.join(dir, "again.yaml")}`)).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, "again.yaml"), "utf8")).toBe(out.stdout);
    const parsed = parseGlossaryFile(out.stdout);
    expect(parsed.ok && parsed.file.rows.length).toBe(856);
    // Reimporting the exported file unchanged makes no changes.
    const back = (await importRun(file, "--as", "opal"));
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toMatch(/0 entries and 856 rows make 856 rows: 0 created, 0 updated, 856 unchanged, 0 existing rows left as they are/);
    expect(back.stdout).toMatch(/glossary version: ([0-9a-f]{12}) -> \1 \(unchanged\)/);
  });
});

it("glossary export CLI reports bad options and flushes a complete YAML document to stdout", { timeout: 90_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glossary-cli-"));
  try {
    const env = { PATH: process.env.PATH, NODE_ENV: "test", PGLITE_DATA_DIR: path.join(dir, "db") };
    const bad = spawnSync(path.join(root, "node_modules/.bin/tsx"), ["scripts/export-glossary.ts", "--bogus"], { env, encoding: "utf8", timeout: 30_000 });
    expect(bad.status).toBe(1); expect(bad.stderr).toContain("usage: pnpm glossary:export");
    expect(fs.existsSync(env.PGLITE_DATA_DIR)).toBe(false);
    const result = spawnSync(path.join(root, "node_modules/.bin/tsx"), ["scripts/export-glossary.ts"], { env, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    const parsed = parseGlossaryFile(result.stdout);
    expect(parsed.ok && parsed.file.entries).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
