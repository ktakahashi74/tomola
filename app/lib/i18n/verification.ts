import { fingerprint } from "./source-hashes";
import { TARGET_LOCALES, type Messages } from "./messages";

// Native-speaker interface verification records (messages/.verified.json). A native speaker must verify the interface before a language is enabled.
// Engine translations remain unverified until reviewed. Record the verified translation fingerprint per key/language
// (first 16 SHA-1 characters of the translation itself, not source). If translation text changes afterward, by engine replacement or manual edit, the fingerprint no longer matches
// and the key becomes unverified again: only the reviewed wording is verified. Missing translations cannot be verified.
// Humans record verification with `pnpm i18n:translate --verify --lang <tag> --all` or `--verify <key>...`. This lets language-opening and
// startup checks require zero missing and zero unverified strings. --check reports both per language. Missing files mean no verification.
// ja/en are manually written and excluded.
// Records also retain who verified and when: per-language $checks contains reviewer name, date, and stamped-key count. One language per verification; --verify requires one language and --by <name>.

export const VERIFIED_FILE = ".verified.json";

// Verification records: reviewers and dates per language.
export type VerificationCheck = { by: string; at: string; keys: number };
export type VerificationChecks = Record<string, VerificationCheck[]>;

// Language → key → verified translation fingerprint.
export type Verified = Record<string, Record<string, string>>;

const keysOf = (m: Messages) => Object.keys(m).filter((k) => k !== "$schema");

// Unverified keys: translation exists, its verified fingerprint differs from current translation; missing records also qualify.
export function unverifiedKeys(source: Messages, messages: Messages, verified: Record<string, string> | undefined): string[] {
  return keysOf(source).filter((key) => key in messages && verified?.[key] !== fingerprint(messages[key]));
}

// Unverified translation counts per language, including zero-count languages.
export function unverifiedCounts(source: Messages, files: Record<string, Messages>, verified: Verified, locales: readonly string[] = TARGET_LOCALES): Record<string, number> {
  return Object.fromEntries(locales.filter((l) => files[l]).map((locale) => [locale, unverifiedKeys(source, files[locale], verified[locale]).length]));
}

// Mark current translations for keys verified, returning new verified data without mutation. Skip missing translations and return them in skipped.
export function markVerified(
  verified: Verified,
  locale: string,
  source: Messages,
  messages: Messages,
  keys: readonly string[],
): { verified: Verified; marked: string[]; skipped: string[] } {
  const next = { ...(verified[locale] ?? {}) };
  const marked: string[] = [];
  const skipped: string[] = [];
  for (const key of keys) {
    if (!(key in source) || key === "$schema" || !(key in messages)) skipped.push(key);
    else {
      next[key] = fingerprint(messages[key]);
      marked.push(key);
    }
  }
  return { verified: { ...verified, [locale]: next }, marked, skipped };
}

// Add reviewer/date records, returning new checks without mutating the original.
export function addCheck(checks: VerificationChecks, locale: string, check: VerificationCheck): VerificationChecks {
  return { ...checks, [locale]: [...(checks[locale] ?? []), check] };
}

export function parseChecks(text: string): VerificationChecks {
  const raw = JSON.parse(text) as { $checks?: unknown };
  const out: VerificationChecks = {};
  if (raw.$checks === null || typeof raw.$checks !== "object") return out;
  for (const [locale, list] of Object.entries(raw.$checks as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    out[locale] = list.flatMap((c) => {
      const v = c as Partial<VerificationCheck> | null;
      return v && typeof v.by === "string" && typeof v.at === "string" && typeof v.keys === "number" ? [{ by: v.by, at: v.at, keys: v.keys }] : [];
    });
  }
  return out;
}

// Record-file shape: source-key order per language. Omit deleted source keys and fingerprints no longer matching current translations after edits. Include reviewer/date $checks if present.
export function serializeVerified(
  verified: Verified,
  source: Messages,
  files: Record<string, Messages>,
  locales: readonly string[] = TARGET_LOCALES,
  checks: VerificationChecks = {},
): string {
  const out: Record<string, unknown> = {
    $comment:
      "The sha1 (first 16 hex digits) of the translated text of each key that a native speaker of the language has checked (pnpm i18n:translate --verify). A key whose text changed after the check is unverified again. pnpm i18n:translate --check reports the counts of missing and unverified keys per language. See README.",
  };
  const written = Object.fromEntries(Object.entries(checks).filter(([, list]) => list.length > 0));
  if (Object.keys(written).length > 0) out.$checks = written;
  for (const locale of locales) {
    const recorded = verified[locale] ?? {};
    const messages = files[locale] ?? {};
    const ordered: Record<string, string> = {};
    for (const key of keysOf(source)) if (key in recorded && key in messages && recorded[key] === fingerprint(messages[key])) ordered[key] = recorded[key];
    out[locale] = ordered;
  }
  return `${JSON.stringify(out, null, 1)}\n`;
}

export function parseVerified(text: string): Verified {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const verified: Verified = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (locale.startsWith("$") || value === null || typeof value !== "object") continue;
    verified[locale] = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return verified;
}
