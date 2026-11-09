import { isDevOrTest } from "~/lib/env.server";
import { loadReviewCounts } from "~/lib/i18n/review-counts.server";
import type { ReviewCounts } from "~/lib/i18n/review-counts";
import { defaultLangOf, LANGS, parseEnabledLangs, type Lang } from "~/lib/languages";

// The languages the site uses (ENABLED_LANGS). The software supports nine languages, the site uses the enabled ones:
// translation jobs, shown translations, the interface language, the main/read/post language choices, and the language of mails are all limited to them.
// Original text is always readable whatever the setting (core 1), and rows for a language that is not enabled are never deleted, only not used.
// The variable is read on every call (a short string), so tests switch it with vi.stubEnv("ENABLED_LANGS", "ja,en").

export type { ReviewCounts } from "~/lib/i18n/review-counts";

type Env = Record<string, string | undefined>;

// The enabled languages in the order of LANGS. A malformed value is stopped at startup by assertEnabledLangsConfigured; throwing here only happens
// when this is called without that check (a script, or a test with a bad value).
export function enabledLangs(env: Env = process.env): readonly Lang[] {
  const parsed = parseEnabledLangs(env.ENABLED_LANGS);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.langs;
}

// Empty means no preview languages; otherwise parse tags exactly like ENABLED_LANGS.
export function previewLangs(env: Env = process.env): readonly Lang[] {
  if (!env.PREVIEW_LANGS?.trim()) return [];
  const parsed = parseEnabledLangs(env.PREVIEW_LANGS);
  if (!parsed.ok) throw new Error(parsed.error.replaceAll("ENABLED_LANGS", "PREVIEW_LANGS"));
  const enabled = enabledLangs(env);
  if (parsed.langs.some(lang => lang === "ja" || lang === "en" || !enabled.includes(lang))) {
    throw new Error("PREVIEW_LANGS must contain enabled languages other than ja and en");
  }
  return parsed.langs;
}

// The same release gate is used at production startup and by langs:open.
export function languageReviewProblems(lang: Lang, review: ReviewCounts[string] | undefined, preview: readonly Lang[]): string[] {
  if (!review) return ["no review counts in the build"];
  if (![review.unverified, review.unverifiedPublic, review.missing, review.stale].every(n => Number.isSafeInteger(n) && n >= 0) || review.unverifiedPublic > review.unverified) return ["invalid review counts in the build (rebuild to include unverified/unverifiedPublic/missing/stale)"];
  const problems: string[] = [];
  if (review.missing > 0 || review.stale > 0) problems.push(`${review.missing} missing and ${review.stale} stale interface string(s)`);
  if (lang !== "ja" && lang !== "en" && !preview.includes(lang) && review.unverifiedPublic > 0) {
    problems.push(`${review.unverifiedPublic} unchecked public machine translation(s) (${review.unverified} unchecked in total)`);
  }
  return problems;
}

export function isEnabledLang(x: unknown, env: Env = process.env): x is Lang {
  return typeof x === "string" && (enabledLangs(env) as readonly string[]).includes(x);
}

// The interface language when nothing else decides, and the fall-back when no enabled language matches: en if it is enabled, otherwise the first enabled language.
export function defaultUiLocale(env: Env = process.env): Lang {
  return defaultLangOf(enabledLangs(env));
}

// Languages a text written in `from` is translated into: the enabled languages minus the original language.
export function enabledTargetLangs(from: string, env: Env = process.env): Lang[] {
  return enabledLangs(env).filter((l) => l !== from);
}

// Startup check (called from assertStartupConfig). A malformed value stops startup in every environment. Production must set ENABLED_LANGS explicitly:
// a forgotten variable would open all nine languages and queue translation jobs for seven languages nobody reads.
export function assertEnabledLangsConfigured(env: Env = process.env): void {
  const parsed = parseEnabledLangs(env.ENABLED_LANGS);
  if (!parsed.ok) throw new Error(parsed.error);
  previewLangs(env);
  if (isDevOrTest(env)) return;
  if (!env.ENABLED_LANGS?.trim()) {
    throw new Error(
      `ENABLED_LANGS is required in production (a comma-separated list of: ${LANGS.join(", ")}). Without it all nine languages would open and translation jobs would be queued for all of them. ` +
        "Start with ja,en; use PREVIEW_LANGS to explicitly open a fully translated language before native-speaker review (docs/deploy.md).",
    );
  }
}

// Production builds require complete, current translations for all enabled languages.
// Native-speaker review of public strings is required unless a language is explicitly in PREVIEW_LANGS.
export function assertEnabledLangsReviewed(env: Env = process.env, counts: ReviewCounts | null = loadReviewCounts()): void {
  const preview = previewLangs(env);
  if (isDevOrTest(env)) return;
  const langs = enabledLangs(env);
  if (counts === null) {
    throw new Error(
      "The build did not embed the review counts of the interface strings (app/lib/i18n/review-counts.generated.json), so ENABLED_LANGS cannot be checked against them. " +
        "Build with `pnpm build` (it runs `pnpm i18n:translate --emit-review-counts` first).",
    );
  }
  const problems: string[] = [];
  for (const lang of langs) {
    problems.push(...languageReviewProblems(lang, counts[lang], preview).map(problem => `${lang}: ${problem}`));
  }
  if (problems.length === 0) return;
  throw new Error(
    `ENABLED_LANGS includes language(s) whose interface strings are incomplete, stale or have not been checked by a native speaker: ${problems.join("; ")}. ` +
      "Fix missing keys, then run `pnpm i18n:translate --check` to check their structure. " +
      "Run `pnpm i18n:translate --stale --lang <tag>`, have a native speaker check the strings and record it with " +
      "`pnpm i18n:translate --verify --lang <tag> --by <name> --all`, rebuild the image, or explicitly set PREVIEW_LANGS for a fully translated language awaiting review. " +
      "In an emergency (a release changed the interface strings and the site is down), remove the language from ENABLED_LANGS and restart: the site starts with the remaining languages, " +
      "and the language can be added again once its strings are checked (docs/deploy.md section 13).",
  );
}
