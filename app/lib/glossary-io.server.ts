import { eq } from "drizzle-orm";
import { Document, isMap, isScalar, parse as parseYaml, visit } from "yaml";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { profiles, user } from "~/lib/db/schema";
import { createGlossaryEntry, loadAllGlossary, loadGlossaryForImport, lockGlossaryForImport, MAX_CANDIDATES, MAX_NOTE_LENGTH, MAX_TERM_LENGTH, resolveProposal, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { matchTermsOf } from "~/lib/glossary-forms";
import { isSingleLine, SINGLE_LINE } from "~/lib/glossary";
import { handleKey } from "~/lib/handles";
import { LANGS, type Lang } from "~/lib/languages";
import { isOperatorEmail } from "~/lib/operators.server";
import { getGlossaryVersion } from "~/lib/translations.server";

// Glossary import/export (`pnpm glossary:import <file> --as <operator handle>`, `pnpm glossary:export`). YAML format; initial entries: docs/drafts/glossary-initial.yaml.
//
// Imports use the three history-recording write functions (createGlossaryEntry/updateGlossaryEntry in glossary.server.ts). --as identifies the operator; history source is import.
// buildGlossaryExport writes only the row-oriented format (rows below). Grouped entries cannot be reconstructed after individual row changes (one-way rows
// or differing candidates per row), making them unsuitable as backups. Imports accept either format or mixed files; rows wins when both create the same row.
//
// File shape: one item per concept, with candidates by language, notes, and two flags:
//
//   format: tomola-glossary
//   version: 1
//   entries:
//     - terms:                      # Terms by language: candidate lists, preferred first. At least two languages. Keys are language tags (ja, en, fr, zh-Hans, zh-Hant, …).
//         en: ["AI alignment"]
//         ja: ["AIアラインメント（AIアライメント）"]       # Preserve manuscript parentheses: variants or notes, interpreted by app/lib/glossary-forms.ts.
//       note: "…"                   # Note supplied with recommended translations in the translation prompt.
//       keep_original: [en]         # Terms in these languages may remain unchanged; translating from them creates keep_original rows.
//       needs_review: [fr, zh-Hans] # Candidates not yet verified by participants in these languages; rows targeting them need review.
//
// Import: create rows for every direction (A → B) between an item's languages. English is not privileged; every source language has equal weight. Row fields:
//   term = source term after parsing parentheses and splitting paired terms at 「／」 (matchTermsOf; one row per term); lang = source language; target_lang = target language;
//   candidates = target-language terms exactly as supplied, including parentheses; note = note; keep_original = source in keep_original; needs_review = target in needs_review.
// By default, import only adds rows. The DB is authoritative; YAML serves initial import/export. List existing rows with differing contents without overwriting them.
//   --update: overwrite differing rows with file contents, except manually edited rows (latest history source admin) and rows reverting verified status to needs-review.
//   --overwrite-edited: includes --update and overwrites those two cases too.
//
// Row-oriented format, the only export format. Each item corresponds to one table row:
//   rows:
//     - {term: "alignment", lang: "en", target_lang: "ja", candidates: ["アラインメント"], note: "", keep_original: false, needs_review: false}
//
// Idempotent: repeated imports of the same file yield the same result; added rows subsequently match. Never delete rows absent from the file.
// Do not restore UI-deleted rows (deleted_at, latest history is UI deletion) even if present in the file. Treat manual deletion like manual edits; --overwrite-edited restores them.
// Glossary version (translations.glossary_version) hashes all row contents (glossaryVersionOf in translations.server.ts): changed imports change it; unchanged imports do not
// with needs-review excluded because it does not affect prompts.
// keep_original does not force source wording. With candidates, the prompt allows either source wording or candidates (app/lib/llm/prompt.server.ts).
//
// Export round trips: buildGlossaryExport writes all active rows in version order, without timestamps, editors, or history. Identical glossary content
// always produces identical bytes and the same version when imported into an empty DB. exportGlossary rebuilds grouped items from rows for comparison with the handwritten source
// (import → exportGlossary → import matches except ordering/comments, tested with actual initial entries); it is not used for exports.

export const GLOSSARY_FORMAT = "tomola-glossary";
export const GLOSSARY_FILE_VERSION = 1;
// Language order in exports.
const LANG_ORDER: readonly Lang[] = ["en", "ja", "fr", "zh-Hans", "zh-Hant", ...LANGS.filter((l) => !["en", "ja", "fr", "zh-Hans", "zh-Hant"].includes(l))];

export type GlossaryFileEntry = {
  terms: Partial<Record<Lang, string[]>>;
  note: string;
  keep_original: Lang[];
  needs_review: Lang[];
};
// Contents for one table row, the import unit.
export type GlossaryRowData = { term: string; lang: Lang; targetLang: Lang; candidates: string[]; note: string; keepOriginal: boolean; needsReview: boolean };
// rows: row-oriented format, exclusively used for exports. entries: grouped format for the initial-entry file. Either may be absent.
export type GlossaryFile = { format: typeof GLOSSARY_FORMAT; version: typeof GLOSSARY_FILE_VERSION; entries: GlossaryFileEntry[]; rows: GlossaryRowData[] };

const langSchema = z.enum(LANGS);
const formSchema = z.string().min(1).max(MAX_TERM_LENGTH).regex(SINGLE_LINE, "must be a single line (no line break, tab or other control character)");
// Candidates of a row are checked in the loop below, so that the error names the row.
const rowCandidateSchema = z.string().min(1).max(MAX_TERM_LENGTH);
const entrySchema = z
  .object({
    terms: z.record(z.string(), z.array(formSchema).min(1).max(MAX_CANDIDATES)),
    note: z.string().max(MAX_NOTE_LENGTH).default(""),
    keep_original: z.array(langSchema).default([]),
    needs_review: z.array(langSchema).default([]),
  })
  .strict();
const rowSchema = z
  .object({
    term: z.string(),
    lang: z.string(),
    target_lang: z.string(),
    candidates: z.array(rowCandidateSchema).max(MAX_CANDIDATES).default([]),
    note: z.string().max(MAX_NOTE_LENGTH).default(""),
    keep_original: z.boolean().default(false),
    needs_review: z.boolean().default(false),
  })
  .strict();
const fileSchema = z
  .object({ format: z.literal(GLOSSARY_FORMAT), version: z.literal(GLOSSARY_FILE_VERSION), entries: z.array(entrySchema).default([]), rows: z.array(rowSchema).default([]) })
  .strict();

export type ParsedGlossary = { ok: true; file: GlossaryFile } | { ok: false; errors: string[] };

// Item label: terms from its first two languages in language order, first term each (example: "AI alignment / AIアライメント"). Do not use item numbers because manuscript order changes. Only termless items
// use their ordinal position.
const labelOf = (terms: Record<string, readonly string[] | undefined> | undefined, index: number): string => {
  const firsts: string[] = [];
  for (const lang of [...LANG_ORDER, ...Object.keys(terms ?? {})]) {
    const first = terms?.[lang]?.find((t) => typeof t === "string" && t.trim() !== "")?.trim();
    if (first && !firsts.includes(first)) firsts.push(first);
    if (firsts.length === 2) break;
  }
  return firsts.length > 0 ? `"${firsts.join(" / ")}"` : `(an entry without words, the ${index + 1}th in the file)`;
};

// Parse YAML text into file contents. Return all shape errors with the item's term label.
export function parseGlossaryFile(text: string): ParsedGlossary {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ok: false, errors: [`the file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const rawEntries = (raw as { entries?: Array<{ terms?: Record<string, readonly string[]> } | null> } | null)?.entries;
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.length > 0 ? i.path.map((p, n) => (n === 1 && typeof p === "number" ? `entry ${labelOf(rawEntries?.[p]?.terms, p)}` : String(p))).join(".") : "file"}: ${i.message}`,
      ),
    };
  }
  const errors: string[] = [];
  const entries: GlossaryFileEntry[] = [];
  parsed.data.entries.forEach((entry, index) => {
    const label = `entry ${labelOf(entry.terms, index)}`;
    const terms: Partial<Record<Lang, string[]>> = {};
    for (const [lang, forms] of Object.entries(entry.terms)) {
      const tag = langSchema.safeParse(lang);
      if (!tag.success) errors.push(`${label}: terms has an unknown language "${lang}" (one of ${LANGS.join(", ")})`);
      else terms[tag.data] = forms.map((f) => f.trim()).filter((f) => f !== "");
    }
    const langs = Object.keys(terms) as Lang[];
    if (langs.length < 2) errors.push(`${label}: terms needs at least two languages`);
    for (const flag of ["keep_original", "needs_review"] as const) {
      for (const lang of entry[flag]) if (!(lang in terms)) errors.push(`${label}: ${flag} names ${lang}, which has no terms`);
    }
    entries.push({ terms, note: entry.note.trim(), keep_original: [...new Set(entry.keep_original)], needs_review: [...new Set(entry.needs_review)] });
  });
  // Row-oriented format: validate languages, terms, and duplicate combinations, with row numbers and terms.
  const rows: GlossaryRowData[] = [];
  const seen = new Set<string>();
  parsed.data.rows.forEach((row, index) => {
    const label = `row ${index + 1} ("${row.term}")`;
    const lang = langSchema.safeParse(row.lang);
    const targetLang = langSchema.safeParse(row.target_lang);
    const term = row.term.trim();
    if (!lang.success) errors.push(`${label}: unknown language "${row.lang}" in lang (one of ${LANGS.join(", ")})`);
    if (!targetLang.success) errors.push(`${label}: unknown language "${row.target_lang}" in target_lang (one of ${LANGS.join(", ")})`);
    if (term === "" || term.length > MAX_TERM_LENGTH) errors.push(`${label}: term must be 1 to ${MAX_TERM_LENGTH} characters`);
    else if (!isSingleLine(term)) errors.push(`${label}: term must be a single line (no line break, tab or other control character)`);
    const multiline = row.candidates.map((c) => c.trim()).filter((c) => c !== "" && !isSingleLine(c));
    for (const c of multiline) errors.push(`${label}: candidate ${JSON.stringify(c)} must be a single line (no line break, tab or other control character)`);
    if (!lang.success || !targetLang.success || term === "" || term.length > MAX_TERM_LENGTH || !isSingleLine(term) || multiline.length > 0) return;
    if (lang.data === targetLang.data) return void errors.push(`${label}: lang and target_lang are the same (${lang.data})`);
    const data: GlossaryRowData = {
      term,
      lang: lang.data,
      targetLang: targetLang.data,
      candidates: row.candidates.map((c) => c.trim()).filter((c) => c !== ""),
      note: row.note.trim(),
      keepOriginal: row.keep_original,
      needsReview: row.needs_review,
    };
    const key = keyOf(data);
    if (seen.has(key)) return void errors.push(`${label}: the row "${term}" (${data.lang} → ${data.targetLang}) is written twice`);
    seen.add(key);
    rows.push(data);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, file: { format: GLOSSARY_FORMAT, version: GLOSSARY_FILE_VERSION, entries, rows } };
}

// conflicts: two items attempt differing contents for the same (term, lang, target_lang), because the manuscript repeats a term in different items. Identify items by terms.
// The unique table key is (term, lang, target_lang). Keep the earlier item's row and omit that source-term direction from the later item. The later item retains rows from its other terms
// and rows translating into that language, allowing export to reconstruct it. Report these as import warnings.
// overrides: rows written in `rows:` that replace a row an entry makes, with different content (the file says two things about one row).
export type ExpandResult = { rows: GlossaryRowData[]; conflicts: string[]; overrides: string[] };

const keyOf = (r: { term: string; lang: string; targetLang: string }) => `${r.lang}\u0000${r.targetLang}\u0000${r.term}`;

// Build table rows in every direction from file contents. For conflicting items creating the same (term, lang, target_lang) with different contents, keep the earlier item and record conflicts.
export function expandGlossaryFile(file: GlossaryFile): ExpandResult {
  const byKey = new Map<string, { row: GlossaryRowData; entry: number }>();
  const conflicts: string[] = [];
  file.entries.forEach((entry, index) => {
    const langs = LANG_ORDER.filter((l) => entry.terms[l]);
    for (const source of langs) {
      const terms = [...new Set((entry.terms[source] ?? []).flatMap((form) => matchTermsOf(form, source)))].filter((t) => t.length <= MAX_TERM_LENGTH);
      for (const target of langs) {
        if (target === source) continue;
        for (const term of terms) {
          const row: GlossaryRowData = {
            term,
            lang: source,
            targetLang: target,
            candidates: [...(entry.terms[target] ?? [])],
            note: entry.note,
            keepOriginal: entry.keep_original.includes(source),
            needsReview: entry.needs_review.includes(target),
          };
          const key = keyOf(row);
          const existing = byKey.get(key);
          if (!existing) byKey.set(key, { row, entry: index });
          else if (existing.entry !== index && JSON.stringify(existing.row) !== JSON.stringify(row)) {
            const [a, b] = [labelOf(file.entries[existing.entry].terms, existing.entry), labelOf(entry.terms, index)];
            conflicts.push(`the entries ${a} and ${b} both make the row "${term}" (${source} → ${target}); the row of ${a} is kept`);
          }
        }
      }
    }
  });
  // Row-oriented rows override the same rows generated by grouped items; exported rows contain the actual content after manual edits.
  const overrides: string[] = [];
  for (const row of file.rows) {
    const existing = byKey.get(keyOf(row));
    if (existing && JSON.stringify(existing.row) !== JSON.stringify(row)) {
      overrides.push(`the row "${row.term}" (${row.lang} → ${row.targetLang}) is written in rows: and also made by the entry ${labelOf(file.entries[existing.entry]?.terms, existing.entry)} with other content; the row in rows: is used`);
    }
    byKey.set(keyOf(row), { row, entry: existing?.entry ?? -1 });
  }
  return { rows: [...byKey.values()].map((v) => v.row), conflicts, overrides };
}

export type SkipReason = "differs" | "edited" | "review_reset";
export type SkippedRow = { term: string; lang: Lang; targetLang: Lang; reason: SkipReason };
export type ImportSummary = {
  created: number;
  updated: number;
  unchanged: number;
  // Existing differing rows left unchanged. differs: default without --update. edited: latest history is manual UI change/deletion. review_reset: would change a verified row back to needs-review.
  skipped: SkippedRow[];
  total: number;
  versionBefore: string | null;
  versionAfter: string | null;
};
export type ImportOptions = {
  now?: Date;
  dryRun?: boolean;
  update?: boolean;
  overwriteEdited?: boolean;
  // Editor: operator specified by --as, required unless dryRun. Always record history source import.
  actor?: Pick<GlossaryActor, "userId" | "scope">;
  // Proposal entry, by URL or number, recorded on every change in this import.
  proposal?: unknown;
};

// Fatal import errors: a write function rejected the operation; roll back the whole import.
export class GlossaryImportError extends Error {}

const sameRow = (a: GlossaryRowData, b: GlossaryRowData) =>
  JSON.stringify([a.candidates, a.note, a.keepOriginal, a.needsReview]) === JSON.stringify([b.candidates, b.note, b.keepOriginal, b.needsReview]);

// Import by (term, lang, target_lang). Default adds only new rows; differing existing rows appear in skipped without changes. update overwrites differing rows.
// Without overwriteEdited, preserve manually edited rows (latest history is UI change/deletion) and prevent resetting needs-review. dryRun returns planned changes without writing.
// All writes use history-recording functions (createGlossaryEntry/updateGlossaryEntry) in one transaction. Any rejection prevents all writes.
// A row matching a UI-deleted combination is restored only with overwriteEdited; createGlossaryEntry restores the same row.
export async function importGlossaryRows(db: Db, rows: readonly GlossaryRowData[], opts: ImportOptions = {}): Promise<ImportSummary> {
  const now = opts.now ?? new Date();
  const update = opts.update === true || opts.overwriteEdited === true;
  if (!opts.dryRun && !opts.actor) throw new Error("importGlossaryRows needs an actor (--as <operator handle>) unless it is a dry run");
  const actor: GlossaryActor | null = opts.actor ? { ...opts.actor, via: "import" } : null;
  const versionBefore = await getGlossaryVersion(db);
  const summary = await db.transaction(async (tx) => {
    // Serialize with the screen edits first (not in a dry run, which writes nothing): the rows read below must still be the rows when the import writes.
    if (!opts.dryRun) await lockGlossaryForImport(tx);
    // Validate the proposal reference before any writes; invalid references leave everything unchanged.
    if (opts.proposal !== undefined && !(await resolveProposal(tx, opts.proposal)).ok) {
      throw new GlossaryImportError(`the proposal "${String(opts.proposal)}" is not a topic of this site (give /t/<id>, the full URL, or the number of a topic that is not deleted or hidden)`);
    }
    const existing = new Map((await loadGlossaryForImport(tx)).map((r) => [keyOf(r), r]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const skipped: SkippedRow[] = [];
    const write = <T extends { ok: true } | { ok: false; error: string }>(result: T, row: GlossaryRowData): T => {
      if (!result.ok) throw new GlossaryImportError(`the row "${row.term}" (${row.lang} → ${row.targetLang}) was refused: ${result.error}`);
      return result;
    };
    for (const row of rows) {
      const old = existing.get(keyOf(row));
      const skip = (reason: SkipReason) => skipped.push({ term: row.term, lang: row.lang, targetLang: row.targetLang, reason });
      if (!old || old.deletedAt !== null) {
        // Do not restore manually UI-deleted rows without --overwrite-edited. Imports never delete, so no import-deleted rows exist, but restore rows whose history source is unknown.
        if (old && old.lastVia === "admin" && !opts.overwriteEdited) {
          skip("edited");
          continue;
        }
        created++;
        if (actor && !opts.dryRun) write(await createGlossaryEntry(tx, actor, row, { now, proposal: opts.proposal }), row);
        continue;
      }
      const current: GlossaryRowData = { term: old.term, lang: old.lang as Lang, targetLang: old.targetLang as Lang, candidates: old.candidates, note: old.note, keepOriginal: old.keepOriginal, needsReview: old.needsReview };
      if (sameRow(row, current)) {
        unchanged++;
        continue;
      }
      const edited = old.lastVia === "admin";
      const reviewReset = !old.needsReview && row.needsReview;
      if (!update) skip(edited ? "edited" : reviewReset ? "review_reset" : "differs");
      else if (edited && !opts.overwriteEdited) skip("edited");
      else if (reviewReset && !opts.overwriteEdited) skip("review_reset");
      else {
        updated++;
        if (actor && !opts.dryRun) write(await updateGlossaryEntry(tx, actor, old.id, row, { now, proposal: opts.proposal }), row);
      }
    }
    return { created, updated, unchanged, skipped, total: rows.length };
  });
  return { ...summary, versionBefore, versionAfter: opts.dryRun ? versionBefore : await getGlossaryVersion(db) };
}

// Check whether the --as handle belongs to an operator (email in OPERATOR_EMAILS), using UI authorization rules. Return reasons for absent/non-operator members without writing.
export async function resolveImportOperator(
  db: Db,
  handle: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; actor: Pick<GlossaryActor, "userId" | "scope"> } | { ok: false; error: "no_such_member" | "not_operator" }> {
  const [row] = await db
    .select({ userId: profiles.userId, email: user.email })
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(profiles.handleKey, handleKey(handle.trim().replace(/^@/, ""))));
  if (!row) return { ok: false, error: "no_such_member" };
  if (!isOperatorEmail(row.email, env)) return { ok: false, error: "not_operator" };
  return { ok: true, actor: { userId: row.userId, scope: { operator: true, langs: [] } } };
}

// ---- Export ----

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

const tupleKey = (lang: string, candidates: readonly string[]) => `${lang}\u0000${JSON.stringify(candidates)}`;

// Rebuild file contents from rows. Each item is a connected component joining (1) rows with identical target language/candidates and (2) rows whose term can be parsed from another row's candidates, when that row targets this row's source language.
// Item terms use candidates from rows targeting each language, unchanged from the file, or source-row terms if absent. note comes from rows; keep_original lists source languages of flagged rows; needs_review lists their target languages.
export function buildGlossaryFile(rows: ReadonlyArray<GlossaryRowData>): GlossaryFile {
  const uf = new UnionFind(rows.length);
  // Rows grouped by target language and candidate list.
  const byTarget = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = tupleKey(row.targetLang, row.candidates);
    const list = byTarget.get(key);
    if (list) list.push(i);
    else byTarget.set(key, [i]);
  });
  for (const list of byTarget.values()) for (const i of list.slice(1)) uf.union(list[0], i);
  // If a row's term can be parsed from a candidate list, join it to rows targeting that list.
  const targetsByLang = new Map<string, Array<{ i: number; terms: Set<string> }>>();
  for (const list of byTarget.values()) {
    const first = list[0];
    const { targetLang, candidates } = rows[first];
    const terms = new Set(candidates.flatMap((c) => matchTermsOf(c, targetLang)));
    const group = targetsByLang.get(targetLang);
    if (group) group.push({ i: first, terms });
    else targetsByLang.set(targetLang, [{ i: first, terms }]);
  }
  rows.forEach((row, i) => {
    for (const target of targetsByLang.get(row.lang) ?? []) {
      // Join only items with the same note, avoiding mixing different items sharing a term.
      if (target.terms.has(row.term) && rows[target.i].note === row.note) uf.union(i, target.i);
    }
  });
  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = uf.find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });
  const entries: GlossaryFileEntry[] = [];
  for (const indexes of groups.values()) {
    const members = indexes.map((i) => rows[i]);
    const terms: Partial<Record<Lang, string[]>> = {};
    for (const m of members) terms[m.targetLang] ??= [...m.candidates];
    for (const m of members) {
      const forms = (terms[m.lang] ??= []);
      if (!members.some((x) => x.targetLang === m.lang) && !forms.includes(m.term)) forms.push(m.term);
    }
    const ordered: Partial<Record<Lang, string[]>> = {};
    for (const lang of LANG_ORDER) if (terms[lang]) ordered[lang] = terms[lang];
    entries.push({
      terms: ordered,
      note: members[0].note,
      keep_original: LANG_ORDER.filter((l) => members.some((m) => m.lang === l && m.keepOriginal)),
      needs_review: LANG_ORDER.filter((l) => members.some((m) => m.targetLang === l && m.needsReview)),
    });
  }
  const firstTerm = (e: GlossaryFileEntry) => e.terms.en?.[0] ?? e.terms.ja?.[0] ?? Object.values(e.terms)[0]?.[0] ?? "";
  entries.sort((a, b) => (firstTerm(a) < firstTerm(b) ? -1 : firstTerm(a) > firstTerm(b) ? 1 : JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return { format: GLOSSARY_FORMAT, version: GLOSSARY_FILE_VERSION, entries, rows: [] };
}

// Rebuild grouped items from active rows for comparison with the handwritten source, not for exports.
export async function exportGlossary(db: Db): Promise<GlossaryFile> {
  const rows = await loadAllGlossary(db);
  return buildGlossaryFile(
    rows.map((r) => ({ term: r.term, lang: r.lang as Lang, targetLang: r.targetLang as Lang, candidates: r.candidates, note: r.note, keepOriginal: r.keepOriginal, needsReview: r.needsReview })),
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Export all active, undeleted rows across nine languages, without language filtering. Use row-oriented format in glossaryVersionOf order: term, source language, target language.
// Omit timestamps, editors, and history to retain import format. History is read through /glossary and Markdown. Identical glossaries yield identical content.
export function glossaryExportFile(rows: ReadonlyArray<GlossaryRowData>): GlossaryFile {
  const sorted = [...rows].sort((a, b) => cmp(a.term, b.term) || cmp(a.lang, b.lang) || cmp(a.targetLang, b.targetLang));
  return { format: GLOSSARY_FORMAT, version: GLOSSARY_FILE_VERSION, entries: [], rows: sorted.map((r) => ({ term: r.term, lang: r.lang, targetLang: r.targetLang, candidates: [...r.candidates], note: r.note, keepOriginal: r.keepOriginal, needsReview: r.needsReview })) };
}

// Export string used by pnpm glossary:export and /glossary.yaml.
export async function buildGlossaryExport(db: Db): Promise<string> {
  const rows = await loadAllGlossary(db);
  return serializeGlossaryFile(
    glossaryExportFile(rows.map((r) => ({ term: r.term, lang: r.lang as Lang, targetLang: r.targetLang as Lang, candidates: r.candidates, note: r.note, keepOriginal: r.keepOriginal, needsReview: r.needsReview }))),
  );
}

// Serialize file contents as YAML in the importable shape. Term lists occupy one line; row-oriented entries use single-line flow maps ({term: …}).
// If both items and rows are absent, write entries: [] so an empty file is more than the two format lines.
export function serializeGlossaryFile(file: GlossaryFile): string {
  const out: Record<string, unknown> = { format: file.format, version: file.version };
  if (file.entries.length > 0 || file.rows.length === 0) out.entries = file.entries;
  if (file.rows.length > 0) {
    out.rows = file.rows.map((r) => ({ term: r.term, lang: r.lang, target_lang: r.targetLang, candidates: r.candidates, note: r.note, keep_original: r.keepOriginal, needs_review: r.needsReview }));
  }
  const doc = new Document(out);
  visit(doc, {
    Seq(_key, node) {
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
  const rows = doc.get("rows", true);
  if (rows && typeof rows === "object" && "items" in rows) for (const item of (rows as { items: unknown[] }).items) if (isMap(item)) item.flow = true;
  return doc.toString({ lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", flowCollectionPadding: false });
}

// Round-trip comparison: JSON with normalized item/language ordering, checking equality except comments/order.
export function canonicalGlossaryJson(file: GlossaryFile): string {
  const entries = file.entries.map((e) => ({
    terms: Object.fromEntries(LANG_ORDER.filter((l) => e.terms[l]).map((l) => [l, e.terms[l]])),
    note: e.note,
    keep_original: LANG_ORDER.filter((l) => e.keep_original.includes(l)),
    needs_review: LANG_ORDER.filter((l) => e.needs_review.includes(l)),
  }));
  entries.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const rows = [...file.rows].sort((a, b) => cmp(a.term, b.term) || cmp(a.lang, b.lang) || cmp(a.targetLang, b.targetLang));
  return JSON.stringify({ format: file.format, version: file.version, entries, rows });
}
