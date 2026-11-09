import { safeErrorText } from "~/lib/error-text.server";
import path from "node:path";
import type { Db } from "~/lib/db/client.server";
import { previewLangs, languageReviewProblems, enabledLangs } from "~/lib/enabled-langs.server";
import { countNeedsReview } from "~/lib/glossary.server";
import { computeReviewCounts, type ReviewCounts } from "~/lib/i18n/review-counts";
import { readHashes, readMessages, readVerified, readVerifiedChecks } from "~/lib/i18n/files.server";
import { ALL_LOCALES, SOURCE_LOCALE, type Messages } from "~/lib/i18n/messages";
import { loadReviewCounts } from "~/lib/i18n/review-counts.server";
import { isLang, type Lang } from "~/lib/languages";
import { primaryEngineId, primaryModelOf } from "~/lib/llm/config.server";
import type { LlmEnv } from "~/lib/llm/types";
import { translationThinking } from "~/lib/llm/config.server";
import { THINKING_HEADROOM } from "~/lib/llm/thinking";
import { costMicro } from "~/lib/llm/pricing.server";
import { ALLOW_FAKE_FLAG, fakeEngineRefusal } from "~/lib/script-guards";
import { requeueTranslations, RequeueLangError } from "~/lib/translations-requeue.server";
import { requestAllVillageTranslations } from "~/lib/village-translations.server";

// `pnpm langs:open <tag> [--dry-run] [--allow-fake] [--allow-unreviewed-glossary]` (scripts/open-lang.ts): the step of opening a language that comes after adding it to ENABLED_LANGS.
// It queues translation jobs for the existing topics and replies into <tag> through the same queue as everything else (topics first, newest activity first), so the monthly budget
// and its degradation apply (a job that hits the budget stays queued and waits). The work is split out of the script so that tests can call it with a database, an environment
// and the review counts of their own.

export type OpenLangDeps = {
  env?: Record<string, string | undefined>;
  // Opens the database (only called after every check that needs no database has passed).
  getDb: () => Promise<Db>;
  // The review counts of the UI strings: the file the build embeds, otherwise counted from messages/ (a development worktree).
  reviewCounts?: () => ReviewCounts;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

const ALLOW_UNREVIEWED_GLOSSARY = "--allow-unreviewed-glossary";
const USAGE = `usage: pnpm langs:open <tag> [--dry-run] [${ALLOW_FAKE_FLAG}] [${ALLOW_UNREVIEWED_GLOSSARY}]`;

// The counts the build embedded; in a development worktree (no generated file) the same counts, taken from messages/ (as `--check --require-verified` counts them).
export function defaultReviewCounts(messagesDir: string = path.join(import.meta.dirname, "../../messages"), load: () => ReviewCounts | null = loadReviewCounts): ReviewCounts {
  const embedded = load();
  if (embedded) return embedded;
  const source = readMessages(messagesDir, SOURCE_LOCALE);
  const hashes = readHashes(messagesDir);
  if (!source || !hashes) throw new Error("cannot count the review state of the interface strings: messages/en.json or messages/.source-hashes.json is missing");
  const files: Record<string, Messages> = {};
  for (const locale of ALL_LOCALES) {
    const found = readMessages(messagesDir, locale);
    if (found) files[locale] = found;
  }
  return computeReviewCounts(source, files, hashes, readVerified(messagesDir), readVerifiedChecks(messagesDir));
}

// Conservative primary-translation estimate: treat every target as a topic,
// counting provisional title, refinement with body context, body, and thinking.
// Replies need fewer calls. This is a planning estimate, not a provider quote.
export function estimateTranslationCost(env: LlmEnv, jobs: number, chars: number): { inputTokens: number; outputTokens: number; usd: number; model: string; engine: string } {
  const engine = primaryEngineId(env);
  const model = primaryModelOf(env);
  // Upper bound: each target is a topic with a provisional title, a refined
  // title (up to 1500 context chars), and body. Counting source twice covers
  // both title calls without fetching private text for estimation.
  const calls = jobs * 3;
  const inputTokens = Math.ceil(chars * 2 / 2) + calls * 2000 + jobs * 750;
  const thinking = engine === "gemini" ? THINKING_HEADROOM[translationThinking(env) === "off" ? "MINIMAL" : translationThinking(env) === "low" ? "LOW" : "default"] : engine === "claude" ? 16384 : 0;
  const outputTokens = Math.ceil(chars * 2 * 1.2) + calls * thinking;
  return { inputTokens, outputTokens, usd: costMicro(engine, model, inputTokens, outputTokens, env) / 1e6, model, engine };
}

// Runs the command. Returns the exit code (0 done, 1 refused or failed); every refusal is explained on stderr and nothing is queued.
export async function runOpenLang(argv: readonly string[], deps: OpenLangDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));

  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const unknown = flags.filter((f) => f !== "--dry-run" && f !== ALLOW_FAKE_FLAG && f !== ALLOW_UNREVIEWED_GLOSSARY);
  if (unknown.length > 0 || positional.length !== 1) {
    error(`${unknown.length > 0 ? `unknown option: ${unknown.join(" ")}\n` : ""}${USAGE}`);
    return 1;
  }
  const tag = positional[0];
  const dryRun = flags.includes("--dry-run");

  // 1. A language the software supports.
  if (!isLang(tag)) {
    error(`langs:open: "${tag}" is not a language of this software. Use one of the nine tags (ja, en, fr, de, zh-Hant, zh-Hans, ko, th, vi); Chinese is named by script.\n${USAGE}`);
    return 1;
  }
  // 2. Added to ENABLED_LANGS (the script and the app read the same variable; in production run it inside the app container: docker compose exec app pnpm langs:open fr).
  let enabled: readonly Lang[];
  try {
    enabled = enabledLangs(env);
    previewLangs(env);
  } catch (e) {
    error(`langs:open: ${safeErrorText(e)}`);
    return 1;
  }
  if (!enabled.includes(tag)) {
    error(`langs:open: ${tag} is not in ENABLED_LANGS (${enabled.join(",")}). Add ${tag} to ENABLED_LANGS and restart the app first, then run this again (in production: docker compose exec app pnpm langs:open ${tag}).`);
    return 1;
  }
  // 3. A fake primary engine would queue jobs that write placeholder translations. Checked before the database is opened.
  let engineId: string;
  try {
    engineId = primaryEngineId(env);
  } catch (e) {
    error(`langs:open: ${safeErrorText(e)}`);
    return 1;
  }
  const refusal = fakeEngineRefusal({ script: "langs:open", engine: "primary translation", engineId, args: argv });
  if (refusal) {
    error(refusal);
    return 1;
  }
  // 4. Apply the same interface completeness and public-review gate as production startup.
  let counts: ReviewCounts;
  try {
    counts = (deps.reviewCounts ?? (() => defaultReviewCounts()))();
  } catch (e) {
    error(`langs:open: ${safeErrorText(e)}`);
    return 1;
  }
  const problems = languageReviewProblems(tag, counts[tag], previewLangs(env));
  if (problems.length > 0) {
    error(`langs:open: the interface strings of ${tag} are not ready: ${problems.join("; ")}. Fix missing/stale strings and rebuild. Review public strings with pnpm i18n:translate --verify --lang ${tag} --by "<name>" --all, or explicitly use PREVIEW_LANGS for a fully translated preview language.`);
    return 1;
  }

  // A database that cannot be opened (a development server holds the PGlite files, the connection string is wrong, ...) is reported without a stack trace, like translations:requeue does.
  let db: Db;
  try {
    db = await deps.getDb();
  } catch (e) {
    error(`langs:open: could not open the database: ${safeErrorText(e)}`);
    return 1;
  }
  // 5. Unlike the interface strings, glossary review lives in the database. Check only active rows whose translation target is this language, including on a dry run.
  const unreviewed = await countNeedsReview(db, tag);
  if (unreviewed > 0) {
    if (!flags.includes(ALLOW_UNREVIEWED_GLOSSARY)) {
      error(
        `langs:open: the glossary of ${tag} is not ready: ${unreviewed} active ${unreviewed === 1 ? "entry still needs" : "entries still need"} review. ` +
          `Have a native speaker check the candidates and mark them as reviewed at /admin/glossary?to=${tag}&review=1 (or import a reviewed glossary file), then run this again. ` +
          `To proceed deliberately with an unreviewed glossary, add ${ALLOW_UNREVIEWED_GLOSSARY}. Nothing was queued.`,
      );
      return 1;
    }
    log(`warning: ${ALLOW_UNREVIEWED_GLOSSARY} was supplied; ${unreviewed} active glossary ${unreviewed === 1 ? "entry still needs" : "entries still need"} review for ${tag}`);
  }
  let result: Awaited<ReturnType<typeof requeueTranslations>>;
  try {
    result = await requeueTranslations(db, { langs: [tag], dryRun, env });
  } catch (e) {
    if (e instanceof RequeueLangError) {
      error(`langs:open: ${e.message}`);
      return 1;
    }
    throw e;
  }
  log(`checked ${result.entries} post(s)`);
  if (dryRun) {
    const { targets, chars } = result.dryRun ?? { targets: 0, chars: 0 };
    const estimate = estimateTranslationCost(env, targets, chars);
    log(`dry run: ${targets} (post x language) translation(s) into ${tag} would be queued (${chars} source characters); nothing was queued`);
    log(`estimated cost with ${estimate.engine}/${estimate.model}: about $${estimate.usd.toFixed(2)} (${estimate.inputTokens} input and ${estimate.outputTokens} output tokens, including thinking allowance; a high estimate)`);
    return 0;
  }
  log(`queued ${result.translate} translate_entry job(s) into ${tag} (topics first, newest activity first)`);
  // The names and descriptions of villages are translated into the new language too (the ones that have no current translation yet).
  const villageJobs = await requestAllVillageTranslations(db, { env });
  if (villageJobs > 0) log(`queued ${villageJobs} translate_village job(s)`);
  log(
    "Next: the worker makes the translations; if the monthly budget is reached the jobs stay queued and wait (check /admin/usage). " +
      "Invite the participants of the language after the translations of the main topics are done and a responder for the language has been decided.",
  );
  return 0;
}
