import { LANGS } from "~/lib/languages";
import { checkStale } from "./source-hashes";
import type { SourceHashes } from "./source-hashes";
import { missingKeys, SOURCE_LOCALE, REFERENCE_LOCALE, type Messages } from "./messages";
import { OPERATOR_ONLY_KEYS } from "./operator-keys";
import { unverifiedKeys, unverifiedCounts, type VerificationChecks, type Verified } from "./verification";

// Per-language review state of the UI strings. Preview languages may have unchecked translations; other languages require review of non-operator strings.
// `pnpm i18n:translate --emit-review-counts` writes it at build time (app/lib/i18n/review-counts.generated.json), the production server reads it at startup
// (assertEnabledLangsReviewed in enabled-langs.server.ts) and `pnpm langs:open` reads it too. It counts the same things as `--check --require-verified`:
//   unverified  translated keys that no native speaker has checked (or that changed after the check)
//   unverifiedPublic  the same count excluding operator-only strings
//   missing     source keys without a message (a missing file is at least one problem)
//   stale       translations whose recorded source fingerprint is obsolete, like --check
// ja and en are written by hand, so their unverified counts are zero. Their structural counts are still required at startup.
// verifiedAt is the date of the last recorded check of the language (null if none); no name is ever written here.
export type LangReview = { unverified: number; unverifiedPublic: number; missing: number; stale: number; verifiedAt?: string | null };
export type ReviewCounts = Readonly<Record<string, LangReview>>;

// The same counting as `pnpm i18n:translate --check --require-verified`, for all nine languages.
export function computeReviewCounts(
  source: Messages,
  files: Record<string, Messages>,
  hashes: SourceHashes,
  verified: Verified,
  checks: VerificationChecks,
): ReviewCounts {
  const targets = LANGS.filter((l) => l !== SOURCE_LOCALE && l !== REFERENCE_LOCALE);
  const unverified = unverifiedCounts(source, files, verified, targets);
  const staleProblems = checkStale(source, files, hashes);
  const keys = Object.keys(source).filter((k) => k !== "$schema").length;
  const out: Record<string, LangReview> = {};
  for (const lang of LANGS) {
    const file = files[lang];
    const structural = { missing: file ? missingKeys(source, file).length : Math.max(1, keys), stale: staleProblems.filter((p) => p.locale === lang).length };
    if (lang === SOURCE_LOCALE || lang === REFERENCE_LOCALE) {
      out[lang] = { unverified: 0, unverifiedPublic: 0, ...structural };
      continue;
    }
    const dates = (checks[lang] ?? []).map((c) => c.at).sort();
    out[lang] = { unverified: file ? (unverified[lang] ?? 0) : 0, unverifiedPublic: file ? unverifiedKeys(source, file, verified[lang]).filter(key => !OPERATOR_ONLY_KEYS.has(key)).length : 0, ...structural, verifiedAt: dates.length > 0 ? dates[dates.length - 1] : null };
  }
  return out;
}

export function serializeReviewCounts(counts: ReviewCounts): string {
  return `${JSON.stringify(counts, null, 2)}\n`;
}

// Parses the generated file. Anything that is not the expected shape is null (the caller treats it like a missing file).
export function parseReviewCounts(value: unknown): ReviewCounts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, LangReview> = {};
  for (const [lang, v] of Object.entries(value as Record<string, unknown>)) {
    if (lang.startsWith("$")) continue;
    const r = v as Partial<LangReview> | null;
    if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
    for (const key of ["unverified", "unverifiedPublic", "missing", "stale"] as const) {
      if (!Number.isSafeInteger(r[key]) || (r[key] as number) < 0) return null;
    }
    if (r.unverifiedPublic! > r.unverified!) return null;
    if ("verifiedAt" in r && r.verifiedAt !== null && typeof r.verifiedAt !== "string") return null;
    out[lang] = { unverified: r.unverified as number, unverifiedPublic: r.unverifiedPublic as number, missing: r.missing as number, stale: r.stale as number, ...("verifiedAt" in r ? { verifiedAt: r.verifiedAt } : {}) };
  }
  return out;
}
