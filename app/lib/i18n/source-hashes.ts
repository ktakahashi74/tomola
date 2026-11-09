import { createHash } from "node:crypto";
import { REFERENCE_LOCALE, TARGET_LOCALES, type CheckProblem, type Message, type Messages } from "./messages";

// Translation source-revision records (messages/.source-hashes.json). After edits to messages/en.json, existing translations remain based on the old source.
// --check would pass if keys/inputs match, missing the source change. Record source fingerprints when pnpm i18n:translate accepts each translation
// (first 16 SHA-1 characters), per language/key. --check reports mismatches with current source as stale and exits 1.
// `pnpm i18n:translate --stale` retranslates only stale keys, the only keys it may overwrite. Update fingerprints only after accepting translations.
// After manual translation edits, such as native-speaker verification, `pnpm i18n:translate --stamp <key>...` records current source fingerprints when the human confirms alignment.
// Includes the manually written Japanese reference as well as engine translations.
export const HASHED_LOCALES = [REFERENCE_LOCALE, ...TARGET_LOCALES] as const;
export const HASHES_FILE = ".source-hashes.json";
export const HASH_LENGTH = 16;

// Language → key → source fingerprint.
export type SourceHashes = Record<string, Record<string, string>>;

export function fingerprint(text: Message): string {
  return createHash("sha1").update(typeof text === "string" ? text : JSON.stringify(text), "utf8").digest("hex").slice(0, HASH_LENGTH);
}

const keysOf = (m: Messages) => Object.keys(m).filter((k) => k !== "$schema");

// Stale translation keys: translation exists but its recorded fingerprint differs from the current source. Missing records also count as stale.
export function staleKeys(source: Messages, existing: Messages, recorded: Record<string, string> | undefined): string[] {
  return keysOf(source).filter((key) => key in existing && recorded?.[key] !== fingerprint(source[key]));
}

// Stamp keys with current source fingerprints, returning new hashes without mutating the original. Ignore keys absent from the source.
export function stamp(hashes: SourceHashes, locale: string, source: Messages, keys: readonly string[]): SourceHashes {
  const next = { ...(hashes[locale] ?? {}) };
  for (const key of keys) if (key in source && key !== "$schema") next[key] = fingerprint(source[key]);
  return { ...hashes, [locale]: next };
}

// Initial records stamping every existing translation with current source fingerprints, after human confirmation that they match.
export function initialHashes(source: Messages, files: Record<string, Messages>, locales: readonly string[] = HASHED_LOCALES): SourceHashes {
  let hashes: SourceHashes = {};
  for (const locale of locales) if (files[locale]) hashes = stamp(hashes, locale, source, keysOf(files[locale]));
  return hashes;
}

// Record-file shape: source-key order within each language, including an explanatory line.
export function serializeHashes(hashes: SourceHashes, source: Messages, locales: readonly string[] = HASHED_LOCALES): string {
  const out: Record<string, unknown> = {
    $comment: "The sha1 (first 16 hex digits) of the English source of each translated key, per language. pnpm i18n:translate --check reports changed source text as stale; --drop-stale removes obsolete translations without API calls. Untranslated keys and their fingerprints are omitted.",
  };
  for (const locale of locales) {
    const recorded = hashes[locale] ?? {};
    const ordered: Record<string, string> = {};
    for (const key of keysOf(source)) if (key in recorded) ordered[key] = recorded[key];
    // Retain extra records until explicitly removed, including in unselected languages.
    for (const key of Object.keys(recorded)) if (!(key in ordered)) ordered[key] = recorded[key];
    out[locale] = ordered;
  }
  return `${JSON.stringify(out, null, 1)}\n`;
}

export function parseHashes(text: string): SourceHashes {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const hashes: SourceHashes = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (locale.startsWith("$") || value === null || typeof value !== "object") continue;
    hashes[locale] = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return hashes;
}

// Existing translations must have a current source fingerprint. Records without a source or translation are errors too.
export function checkStale(source: Messages, files: Record<string, Messages>, hashes: SourceHashes, locales: readonly string[] = HASHED_LOCALES): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const locale of locales) {
    const messages = files[locale] ?? {};
    for (const key of staleKeys(source, messages, hashes[locale])) {
      const known = hashes[locale]?.[key] !== undefined;
      problems.push({
        locale,
        key,
        problem: known
          ? "stale: the English source changed after this was translated (pnpm i18n:translate --stale, --drop-stale, or --stamp <key> after fixing it by hand)"
          : "stale: no source fingerprint is recorded for this translation (pnpm i18n:translate --stale, --drop-stale, or --stamp <key> if it already matches the English)",
      });
    }
    for (const key of Object.keys(hashes[locale] ?? {})) {
      if (key === "$schema" || !(key in source) || !(key in messages)) {
        problems.push({ locale, key, problem: "orphan: source fingerprint has no source or translation (pnpm i18n:translate --drop-stale)" });
      }
    }
  }
  return problems;
}
