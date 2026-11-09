import { defaultLangOf, isLang, LANGS, type Lang } from "~/lib/languages";
import { HIDDEN_PRIMARY_FLAGS } from "~/lib/llm/flags";

// Translation display rules: pure functions used by server loaders, independent of DB/React for testing.
//
// - Show the source by default if its language is in the reader's read_langs or matches the display language.
// - Otherwise default to a translation in the display language. Prefer current human > current primary > human based on an older source revision (stale human)
//   with no author translations.
//   Use primary machine translations only if their source_hash matches the current source. Do not show the old translation immediately after an edit.
//   Also hide primary translations flagged link_mismatch (added links absent from the source) or untranslated, treating them as pending.
//   Keep human translations after source edits and flag them stale. If a current primary exists for that language,
//   do not default to the old human translation; show the new primary and offer the old one as 「古い版の原文に基づく訳」 in the toggle.
//   If no current primary exists yet, show the old human translation with 「原文が更新されています」.
//   Do not display secondary translations, used for disagreement measurement.
// - If no translation exists yet, show the source with 「翻訳待ち」.
// - In either case, allow toggling between source and translation.

export type ShownKind = "human" | "primary";
export const SHOWN_KINDS: readonly ShownKind[] = ["human", "primary"];

export function isShownKind(kind: string): kind is ShownKind {
  return kind === "human" || kind === "primary";
}

type Row = { kind: string; sourceHash: string | null; mentionRevision?: number | null; flags?: readonly string[] };

// Priority, lower first: current human (0), current primary (1), stale human (2). Null for rows that must not be shown.
const RANK_STALE_HUMAN = 2;
function rank(row: Row, entrySourceHash: string | null, mentionRevision?: number): number | null {
  if (row.kind === "primary") return isUsablePrimary(row, entrySourceHash, mentionRevision) ? 1 : null;
  if (row.kind !== "human") return null;
  return isStale(row.flags ?? []) || (mentionRevision !== undefined && row.mentionRevision != null && row.mentionRevision !== mentionRevision) ? RANK_STALE_HUMAN : 0;
}

// Choose the default display from translation rows for the same entry/field/language. Null if none.
export function pickTranslation<T extends Row>(rows: readonly T[], entrySourceHash: string | null, mentionRevision?: number): (T & { kind: ShownKind }) | null {
  let best: { row: T; rank: number } | null = null;
  for (const row of rows) {
    const r = rank(row, entrySourceHash, mentionRevision);
    if (r !== null && (best === null || r < best.rank)) best = { row, rank: r };
  }
  return best ? (best.row as T & { kind: ShownKind }) : null;
}

// Older-source translation (stale human), available for selection but not the default. Only when the default is current human or primary
// (if the default is already stale human, there is nothing older). Null if none.
export function pickOlderTranslation<T extends Row>(rows: readonly T[], entrySourceHash: string | null, mentionRevision?: number): (T & { kind: "human" }) | null {
  const shown = pickTranslation(rows, entrySourceHash, mentionRevision);
  if (shown === null || rank(shown, entrySourceHash, mentionRevision) === RANK_STALE_HUMAN) return null;
  for (const row of rows) {
    if (rank(row, entrySourceHash, mentionRevision) === RANK_STALE_HUMAN) return row as T & { kind: "human" };
  }
  return null;
}

// Whether primary may be displayed: based on the current source revision without exclusion flags (link_mismatch, untranslated).
export function isUsablePrimary(row: { sourceHash: string | null; mentionRevision?: number | null; flags?: readonly string[] }, entrySourceHash: string | null, mentionRevision?: number): boolean {
  if (entrySourceHash === null || row.sourceHash !== entrySourceHash) return false;
  if (mentionRevision !== undefined && row.mentionRevision != null && row.mentionRevision !== mentionRevision) return false;
  return !(row.flags ?? []).some((f) => HIDDEN_PRIMARY_FLAGS.includes(f));
}

export function isStale(flags: readonly string[]): boolean {
  return flags.includes("stale");
}

// Whether to default to a translation: the source language is neither readable by this reader nor the display language.
export function wantsTranslation(entryLang: string, readLangs: readonly string[], displayLang: string): boolean {
  if (entryLang === displayLang) return false;
  return !readLangs.includes(entryLang);
}

// original: source; translation: default translation; older: human translation based on an older source revision.
export type Shown = "original" | "translation" | "older";

// Default displayed revision. force specifies ?orig=<id> (source), ?tr=<id> (translation), or ?old=<id> (older-source translation).
// If the requested revision is absent, use a translation if available, otherwise the source.
export function decideShown(opts: { wants: boolean; hasTranslation: boolean; hasOlder?: boolean; force?: Shown | null }): Shown {
  if (opts.force === "original") return "original";
  if (opts.force === "older" && opts.hasOlder) return "older";
  if (opts.force === "translation" || opts.force === "older") return opts.hasTranslation ? "translation" : "original";
  return opts.wants && opts.hasTranslation ? "translation" : "original";
}

// Translation language: page override > saved preference > interface locale > first original-reading language > enabled default.
// UI callers supply the current locale; machine reads and mail supply the stored profile locale. Every candidate must be enabled.
// `enabled` defaults to all nine languages.
export function resolveDisplayLang(opts: {
  query?: string | null;
  profile: { displayLang: Lang | null; readLangs: readonly Lang[] };
  uiLocale?: string | null;
  enabled?: readonly Lang[];
}): Lang {
  const enabled = opts.enabled ?? LANGS;
  if (isLang(opts.query) && enabled.includes(opts.query)) return opts.query;
  if (opts.profile.displayLang && enabled.includes(opts.profile.displayLang)) return opts.profile.displayLang;
  if (isLang(opts.uiLocale) && enabled.includes(opts.uiLocale)) return opts.uiLocale;
  return opts.profile.readLangs.find((l) => enabled.includes(l)) ?? defaultLangOf(enabled);
}

// Entry-id parameters such as ?orig=1&orig=2. Discard non-numeric values.
export function parseIdSet(values: readonly string[]): Set<number> {
  const ids = new Set<number>();
  for (const v of values) if (/^[1-9]\d{0,15}$/.test(v)) ids.add(Number(v));
  return ids;
}

// Authentication return destinations use the reader's preferences, not forced post versions.
export function clearToggleSearch(currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  let changed = false;
  for (const name of ["orig", "tr", "old"]) {
    if (!params.has(name)) continue;
    changed = true;
    params.delete(name);
  }
  if (!changed) return currentSearch;
  const search = params.toString();
  return search ? `?${search}` : "";
}

// Source/translation toggle link, with the same result without JavaScript. Replace this entry's orig/tr/old in the current query.
const TOGGLE_PARAM: Record<Shown, string> = { original: "orig", translation: "tr", older: "old" };
export function toggleSearch(currentSearch: string, entryId: number, target: Shown): string {
  const params = new URLSearchParams(currentSearch);
  const id = String(entryId);
  for (const name of Object.values(TOGGLE_PARAM)) {
    const rest = params.getAll(name).filter((v) => v !== id);
    params.delete(name);
    for (const v of rest) params.append(name, v);
  }
  params.append(TOGGLE_PARAM[target], id);
  const search = params.toString();
  return search ? `?${search}` : "";
}
