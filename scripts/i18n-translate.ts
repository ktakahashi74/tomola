import { safeErrorText } from "../app/lib/error-text.server.ts";
// Translate interface messages from messages/en.json with ja.json reference into fr, de, zh-Hant, zh-Hans, ko, th, vi through the project's LLM layer (Gemini/Claude).
//
//   pnpm i18n:translate                  Add missing keys for each of seven languages to messages/<language>.json using the primary engine by default, selectable with --engine.
//   pnpm i18n:translate --engine claude --model claude-sonnet-5-5   Choose engine (gemini | claude; fake needs --allow-fake) and model. Defaults: primary from TRANSLATION_PRIMARY or GEMINI_API_KEY availability; I18N_MODEL or engine default gemini-3.8-flash/claude-sonnet-5-5.
//   pnpm i18n:translate --lang fr,de     Restrict languages.
//   pnpm i18n:translate --limit 5        Translate only the first N missing keys per language for a trial.
//   pnpm i18n:translate --batch-size 250 Keys per call, default 40. --max-calls N caps calls and stops when exceeded, for keys with small daily free quotas.
//   pnpm i18n:translate --dry-run        Estimate missing keys/costs without calls.
//   pnpm i18n:translate --check          Validate saved files without calls: missing en/ja keys, extra keys, {name} inputs, empty values, newlines, preserved terms, stale translations, and orphan source fingerprints. Exit 1 on issues.
//                                        Also report per-language missing/unverified counts without treating them as issues.
//   pnpm i18n:translate --verify --lang fr --by "<reviewer name>" --all   Record native-speaker verification of all current translations in that language, including reviewer/date in messages/.verified.json.
//                                        Skip missing translations. --verify --lang fr --by "<name>" <keys>... records only those keys. --lang must specify exactly one language, never bulk-verify multiple languages;
//                                        reject missing --lang or --by without any writes (exit 1).
//                                        Later translation changes, engine or manual, make keys unverified again. Records allow languages to open only after native review, enforced by startup checks.
//   pnpm i18n:translate --stale          Retranslate only old-source keys whose recorded fingerprints differ from current en.json. Only stale keys may be overwritten.
//   pnpm i18n:translate --stamp <keys>...  Record current source fingerprints after humans update translations to match current source. --lang restricts languages.
//   pnpm i18n:translate --drop-stale     Without API calls, remove obsolete translations, extra keys and orphan source fingerprints. --lang restricts languages.
//   pnpm i18n:translate --check --strict Count missing translations as issues (exit 1) before opening languages. --check alone reports them without issues (exit 0).
//   pnpm i18n:translate --check --require-verified   Count unverified non-operator strings and all missing strings as issues (exit 1) before language opening,
//                                        so untranslated languages cannot pass verification requirements. May combine with --strict.
//   pnpm i18n:translate --emit-review-counts   without calling any API, writes per language the number of missing, stale and unverified keys and the date of the last check to
//                                        app/lib/i18n/review-counts.generated.json (counted like --check --require-verified; the name of the person who checked is not written).
//                                        pnpm build runs it first, and the production startup check reads the file
//   pnpm i18n:translate --init-hashes    Create messages/.source-hashes.json only if absent, treating all current translations as matching current source.
//
// Stale detection: on each accepted translation, record its source fingerprint (first 16 SHA-1 characters) per language in messages/.source-hashes.json (app/lib/i18n/source-hashes.ts).
// Update fingerprints only after acceptance/file writes. Failed keys stay stale and continue appearing in --check.
// Never overwrite existing translations except stale keys under --stale. Add only missing keys, allowing interrupted runs to resume. Before acceptance, validate matching input sets, newline counts, preserved terms,
// scripts, and absence of untranslated copies. Retry failures with explanations up to three times; omit persistent failures and exit 1.
// Environment: GEMINI_API_KEY or ANTHROPIC_API_KEY for the chosen engine, required except --check/--verify/--dry-run; TRANSLATION_PRIMARY; I18N_MODEL. Calculate/display costs from usage without DB records:
// one-time build costs, separate from runtime monthly llm_usage budget. Stop beyond --max-cost-usd (default 5). Reject fake without --allow-fake because it writes fake interface translations.
import fs from "node:fs";
import { cliOutput, isMain, type CliOutput } from "./cli";
import path from "node:path";
import { messageText, checkMessages, missingKeys, ALL_LOCALES, REFERENCE_LOCALE, SOURCE_LOCALE, TARGET_LOCALES, type Messages } from "../app/lib/i18n/messages";
import { checkStale, HASHED_LOCALES, HASHES_FILE, initialHashes, serializeHashes, stamp } from "../app/lib/i18n/source-hashes";
import { keysToTranslate, dropStaleFiles, readHashes, readMessages, readVerified, readVerifiedChecks, translateFiles, writeHashes, writeVerified } from "../app/lib/i18n/files.server";
import { FatalTranslationError } from "../app/lib/i18n/translate-messages.server";
import { OPERATOR_ONLY_KEYS } from "../app/lib/i18n/operator-keys";
import { computeReviewCounts, serializeReviewCounts } from "../app/lib/i18n/review-counts";
import { addCheck, markVerified, unverifiedCounts, unverifiedKeys, VERIFIED_FILE } from "../app/lib/i18n/verification";
import type { Lang } from "../app/lib/languages";
import { modelMatchesProvider, primaryEngineId } from "../app/lib/llm/config.server";
import { createJsonCompleter, DEFAULT_I18N_MODELS } from "../app/lib/llm/completion.server";
import { LlmError } from "../app/lib/llm/errors.server";
import { costMicro } from "../app/lib/llm/pricing.server";
import type { EngineId } from "../app/lib/llm/types";
import { ALLOW_FAKE_FLAG } from "../app/lib/script-guards";

function parseArgs(argv: string[]) {
  const args = {
    check: false,
    strict: false,
    requireVerified: false,
    dropStale: false,
    dryRun: false,
    stale: false,
    stamp: false,
    verify: false,
    all: false,
    allowFake: false,
    initHashes: false,
    emitReviewCounts: false,
    stampKeys: [] as string[],
    verifyKeys: [] as string[],
    by: null as string | null,
    langExplicit: false,
    engine: null as EngineId | null,
    model: null as string | null,
    langs: [...TARGET_LOCALES] as Lang[],
    limit: Infinity,
    maxCostUsd: 5,
    batchSize: 40,
    maxCalls: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--require-verified") args.requireVerified = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--by") {
      args.by = (argv[++i] ?? "").trim();
      if (!args.by || args.by.startsWith("--")) throw new Error("--by takes the name of the person who checked the translation");
    }
    else if (a === "--all") args.all = true;
    else if (a === ALLOW_FAKE_FLAG) args.allowFake = true;
    else if (a === "--engine") {
      const engine = argv[++i];
      if (engine !== "gemini" && engine !== "claude" && engine !== "fake") throw new Error("--engine takes gemini, claude or fake");
      args.engine = engine;
    } else if (a === "--model") {
      args.model = (argv[++i] ?? "").trim();
      if (!args.model) throw new Error("--model takes a model name");
    }
    else if (a === "--drop-stale") args.dropStale = true;
    else if (a === "--stale") args.stale = true;
    else if (a === "--init-hashes") args.initHashes = true;
    else if (a === "--emit-review-counts") args.emitReviewCounts = true;
    else if (a === "--stamp") args.stamp = true;
    else if (args.stamp && !a.startsWith("--")) args.stampKeys.push(a);
    else if (args.verify && !a.startsWith("--")) args.verifyKeys.push(a);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--lang") {
      const wanted = (argv[++i] ?? "").split(",").filter(Boolean);
      const bad = wanted.filter((l) => !(HASHED_LOCALES as readonly string[]).includes(l));
      if (bad.length > 0 || wanted.length === 0) throw new Error(`--lang takes a comma-separated list of: ${HASHED_LOCALES.join(", ")}`);
      args.langs = wanted as Lang[];
      args.langExplicit = true;
    } else if (a === "--limit") {
      args.limit = Number(argv[++i]);
      if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit takes a positive integer");
    } else if (a === "--batch-size") {
      args.batchSize = Number(argv[++i]);
      if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 600) throw new Error("--batch-size takes an integer from 1 to 600 (keys per call)");
    } else if (a === "--max-calls") {
      args.maxCalls = Number(argv[++i]);
      if (!Number.isInteger(args.maxCalls) || args.maxCalls < 1) throw new Error("--max-calls takes a positive integer");
    } else if (a === "--max-cost-usd") {
      args.maxCostUsd = Number(argv[++i]);
      if (!Number.isFinite(args.maxCostUsd) || args.maxCostUsd <= 0) throw new Error("--max-cost-usd takes a positive number");
    } else throw new Error(`unknown argument: ${a}\nusage: pnpm i18n:translate [--check [--strict] [--require-verified]] [--drop-stale] [--stale] [--stamp <key>...] [--verify --lang <one language> --by <name> (--all | <key>...)] [--init-hashes] [--emit-review-counts] [--engine gemini|claude] [--model <name>] [--dry-run] [--lang fr,de] [--limit N] [--batch-size N] [--max-calls N] [--max-cost-usd N] [${ALLOW_FAKE_FLAG}]`);
  }
  if (args.langs.includes(REFERENCE_LOCALE) && !args.stamp && !args.check) throw new Error("ja is written by hand; use --stamp after updating its translation");
  return args;
}

export async function runI18n(argv: string[], env: NodeJS.ProcessEnv = process.env, output: CliOutput = cliOutput): Promise<number> {
  // I18N_MESSAGES_DIR: message directory for tests, default messages/.
  const messagesDir = path.resolve(env.I18N_MESSAGES_DIR ?? path.join(import.meta.dirname, "../messages"));
  // I18N_REVIEW_COUNTS_FILE: where --emit-review-counts writes (tests; the default is the file the production server reads).
  const reviewCountsPath = path.resolve(env.I18N_REVIEW_COUNTS_FILE ?? path.join(import.meta.dirname, "../app/lib/i18n/review-counts.generated.json"));

  const read = (locale: string): Messages | null => readMessages(messagesDir, locale);
  const hashesPath = path.join(messagesDir, HASHES_FILE);

  const args = parseArgs(argv);
  const source = read(SOURCE_LOCALE);
  const reference = read(REFERENCE_LOCALE);
  if (!source || !reference) throw new Error(`messages/${SOURCE_LOCALE}.json and messages/${REFERENCE_LOCALE}.json are required`);

  if (args.emitReviewCounts) {
    // No API call. The same counting as --check --require-verified, for all nine languages; the production server checks ENABLED_LANGS against it.
    const recorded = readHashes(messagesDir);
    if (recorded === null) throw new Error(`messages/${HASHES_FILE} is missing (create it once with pnpm i18n:translate --init-hashes)`);
    const files: Record<string, Messages> = {};
    for (const locale of ALL_LOCALES) {
      const m = read(locale);
      if (m) files[locale] = m;
    }
    const counts = computeReviewCounts(source, files, recorded, readVerified(messagesDir), readVerifiedChecks(messagesDir));
    fs.mkdirSync(path.dirname(reviewCountsPath), { recursive: true });
    fs.writeFileSync(reviewCountsPath, serializeReviewCounts(counts));
    output.log(`wrote ${path.relative(process.cwd(), reviewCountsPath)}: ${Object.entries(counts).map(([l, c]) => `${l} ${c.unverified}/${c.unverifiedPublic}/${c.missing}/${c.stale}`).join(", ")} (unverified/unverifiedPublic/missing/stale)`);
    return 0;
  }

  if (args.check) {
    const files: Record<string, Messages> = {};
    for (const locale of ALL_LOCALES) {
      const m = read(locale);
      if (m) files[locale] = m;
    }
    const problems = checkMessages(files, { locales: ALL_LOCALES });
    const recorded = readHashes(messagesDir);
    if (recorded === null) problems.push({ locale: "", key: "", problem: `messages/${HASHES_FILE} is missing (create it once with pnpm i18n:translate --init-hashes)` });
    else {
      problems.push(...checkStale(source, files, recorded));
      const counts = Object.fromEntries(args.langs.map(locale => [locale, missingKeys(source, files[locale] ?? {}).length]));
      output.log(`missing (not translated yet; English fallback): ${Object.entries(counts).map(([l, c]) => `${l} ${c}`).join(", ")}`);
      if (args.strict || args.requireVerified) {
        for (const locale of args.langs) {
          if (!files[locale]) continue; // The structural check already reports the missing file.
          for (const key of missingKeys(source, files[locale])) problems.push({ locale, key, problem: "missing: not translated yet; English fallback is in use" });
        }
      }
      // Report per-language unverified counts, treating them as issues only with --require-verified.
      const verified = readVerified(messagesDir);
      const reviewedLangs = args.langs.filter(locale => locale !== REFERENCE_LOCALE);
      const unverified = unverifiedCounts(source, files, verified, reviewedLangs);
      // Latest per-language reviewer/date record, if present.
      const checks = readVerifiedChecks(messagesDir);
      const lastChecks = args.langs.flatMap((l) => (checks[l]?.length ? [`${l} ${checks[l][checks[l].length - 1].by} ${checks[l][checks[l].length - 1].at}`] : []));
      if (lastChecks.length > 0) output.log(`last native-speaker check: ${lastChecks.join(", ")}`);
      output.log(`unverified (machine-translated, not yet checked by a native speaker; pnpm i18n:translate --verify): ${Object.entries(unverified).map(([l, c]) => `${l} ${c}`).join(", ")}`);
      const publicUnverified = Object.fromEntries(reviewedLangs.filter(locale => files[locale]).map(locale => [locale, unverifiedKeys(source, files[locale], verified[locale]).filter(key => !OPERATOR_ONLY_KEYS.has(key)).length]));
      output.log(`unverified excluding operator-only strings: ${Object.entries(publicUnverified).map(([l, c]) => `${l} ${c}`).join(", ")}`);
      if (args.requireVerified) {
        for (const locale of reviewedLangs) {
          if (!files[locale]) continue;
          for (const key of unverifiedKeys(source, files[locale], verified[locale]).filter(key => !OPERATOR_ONLY_KEYS.has(key))) {
            problems.push({ locale, key, problem: "unverified: no native speaker of the language has checked this translation yet (pnpm i18n:translate --verify)" });
          }
        }
      }
    }
    for (const p of problems) output.error(`${p.locale}${p.key ? `/${p.key}` : ""}: ${p.problem}`);
    output.log(problems.length === 0 ? `messages: ${ALL_LOCALES.length} languages, ${Object.keys(source).filter(key => key !== "$schema").length} source keys, no problems` : `${problems.length} problem(s)`);
    return problems.length === 0 ? 0 : 1;
  }

  if (args.initHashes) {
    if (fs.existsSync(hashesPath)) throw new Error(`messages/${HASHES_FILE} already exists (--init-hashes would hide stale translations; delete it only if you have checked every translation against the English)`);
    const files: Record<string, Messages> = {};
    for (const locale of HASHED_LOCALES) {
      const m = read(locale);
      if (m) files[locale] = m;
    }
    fs.writeFileSync(hashesPath, serializeHashes(initialHashes(source, files), source));
    output.log(`wrote messages/${HASHES_FILE}: the current translations are recorded as matching the current English`);
    return 0;
  }

  let hashes = readHashes(messagesDir);
  if (hashes === null) throw new Error(`messages/${HASHES_FILE} is missing (create it once with pnpm i18n:translate --init-hashes)`);

  if (args.stamp) {
    const unknown = args.stampKeys.filter((k) => !(k in source) || k === "$schema");
    if (args.stampKeys.length === 0 || unknown.length > 0) throw new Error(`--stamp takes the keys of messages/${SOURCE_LOCALE}.json${unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""}`);
    for (const locale of args.langs) {
      const m = read(locale);
      if (!m) continue;
      hashes = stamp(hashes, locale, source, args.stampKeys.filter((k) => k in m));
    }
    writeHashes(messagesDir, hashes, source);
    output.log(`recorded the current English of ${args.stampKeys.length} key(s) for ${args.langs.join(", ")}`);
    return 0;
  }

  if (args.verify) {
    // Record native-speaker verification without API calls. Require exactly one --lang and reviewer name in --by, otherwise stop without writes. Require --all or keys.
    if (!args.langExplicit || args.langs.length !== 1) {
      throw new Error('--verify takes --lang with exactly one language (a native speaker checks one language; several languages are not marked as checked together): pnpm i18n:translate --verify --lang fr --by "<name>" --all');
    }
    if (!args.by) throw new Error('--verify takes --by <name>: the person who checked the translation (recorded with the date in messages/.verified.json): pnpm i18n:translate --verify --lang fr --by "<name>" --all');
    if (args.all === (args.verifyKeys.length > 0)) throw new Error("--verify takes --all (every translated key of the language) or the keys to record, not both and not neither");
    const unknown = args.verifyKeys.filter((k) => !(k in source) || k === "$schema");
    if (unknown.length > 0) throw new Error(`--verify takes the keys of messages/${SOURCE_LOCALE}.json (unknown: ${unknown.join(", ")})`);
    let verified = readVerified(messagesDir);
    const files: Record<string, Messages> = {};
    for (const locale of TARGET_LOCALES) {
      const m = read(locale);
      if (m) files[locale] = m;
    }
    let checks = readVerifiedChecks(messagesDir);
    for (const locale of args.langs) {
      const messages = files[locale];
      if (!messages) continue;
      const keys = args.all ? Object.keys(source).filter((k) => k !== "$schema") : args.verifyKeys;
      const result = markVerified(verified, locale, source, messages, keys);
      verified = result.verified;
      const at = new Date().toISOString().slice(0, 10);
      if (result.marked.length > 0) checks = addCheck(checks, locale, { by: args.by, at, keys: result.marked.length });
      const note = result.skipped.length > 0 ? `; ${result.skipped.length} key(s) not recorded (no translation)` : "";
      output.log(`${locale}: recorded the native-speaker check of ${result.marked.length} key(s) by ${args.by} on ${at}${note}`);
    }
    writeVerified(messagesDir, verified, source, files, checks);
    return 0;
  }

  if (args.dropStale) {
    const summary = dropStaleFiles({ dir: messagesDir, locales: args.langs });
    for (const s of summary) output.log(`${s.locale}: ${s.keys} translation key(s) removed; ${s.hashes} source fingerprint(s) removed`);
    return 0;
  }

  const plans = args.langs.map((locale) => ({ locale, keys: keysToTranslate(messagesDir, locale, args.stale ? "stale" : "missing", args.limit) }));
  const total = plans.reduce((n, p) => n + p.keys.length, 0);
  if (total === 0) {
    output.log(args.stale ? "nothing to translate: no translation is stale" : "nothing to translate: every target file has every key");
    return 0;
  }
  for (const p of plans) output.log(`${p.locale}: ${p.keys.length} ${args.stale ? "stale " : ""}key(s) to translate`);
  // Engine/model: --engine or primary from TRANSLATION_PRIMARY/GEMINI_API_KEY availability; --model or I18N_MODEL or the engine's default.
  const engine: EngineId = args.engine ?? primaryEngineId(env);
  const model = args.model ?? env.I18N_MODEL?.trim() ?? DEFAULT_I18N_MODELS[engine];
  const modelName = model === "" ? DEFAULT_I18N_MODELS[engine] : model;
  if (!modelMatchesProvider(engine, modelName)) throw new Error(`the model "${modelName}" is not a ${engine} model: pass --model with a ${engine} model name (or --engine for the provider of that model)`);
  const sourceChars = plans.reduce((n, p) => n + p.keys.reduce((c, k) => c + messageText(source[k]).length + (reference[k] ? messageText(reference[k]).length : 0), 0), 0);
  // Estimate input from source/reference/instructions: roughly 12 tokens per key plus 1,500 per-call instruction tokens. Output tokens approximate twice the source character count; thinking tokens are separate.
  const estIn = Math.ceil(sourceChars / 3) + plans.length * 15 * 1500;
  const estOut = Math.ceil(sourceChars * 1.2);
  output.log(`engine ${engine}, model ${modelName}; estimated about ${estIn} input and ${estOut}+ output tokens (about $${(costMicro(engine, modelName, estIn, estOut) / 1e6).toFixed(2)} before thinking tokens)`);
  if (args.dryRun) return 0;

  if (engine === "fake" && !args.allowFake) {
    throw new Error(
      `the translation engine is fake (${args.engine === "fake" ? "--engine fake" : "no GEMINI_API_KEY, or TRANSLATION_PRIMARY=fake"}): it would write placeholder translations into messages/*.json. ` +
        `GEMINI_API_KEY is not set (and TRANSLATION_PRIMARY does not name another engine): set the key of the engine you want, or pass --engine gemini|claude with its key; pass ${ALLOW_FAKE_FLAG} only if the fake engine is what you mean (tests, a dry check of this script).`,
    );
  }
  // Require the chosen engine's key here, stopping before any calls if absent.
  const completer = (() => {
    try {
      return createJsonCompleter(engine, modelName, env);
    } catch (error) {
      if (error instanceof LlmError && error.code === "config") throw new Error(error.message);
      throw error;
    }
  })();
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  const spentUsd = () => costMicro(engine, modelName, inputTokens, outputTokens) / 1e6;
  // Wait and retry the same call for transient failures (busy 503, rate-limit 429, disconnects). Do not count these toward per-key attempts.
  const transient = (error: unknown) => /\b(429|500|502|503|504|529)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE|ECONNRESET|ETIMEDOUT|fetch failed|overloaded|rate_limit/i.test(safeErrorText(error));
  const complete = async (req: { system: string; user: string; maxOutputTokens: number }) => {
    for (let wait = 10_000, attempt = 1; ; wait *= 2, attempt++) {
      // Count only calls returning responses, which count toward billing/daily quota. Exclude transient failures such as 503.
      if (calls >= args.maxCalls) throw new FatalTranslationError(`reached --max-calls ${args.maxCalls}; run it again to continue from where it stopped`);
      try {
        const out = await completer.complete(req);
        calls += 1;
        inputTokens += out.inputTokens;
        outputTokens += out.outputTokens;
        return out;
      } catch (error) {
        // Calls returning unusable responses, such as truncated output, are still billed.
        if (error instanceof LlmError && error.usage) {
          calls += 1;
          inputTokens += error.usage.inputTokens;
          outputTokens += error.usage.outputTokens;
        }
        const text = safeErrorText(error);
        // Exhausted daily quota cannot recover through waiting; free tiers have small per-model daily call counts.
        if (/PerDay|daily/i.test(text) && /quota|RESOURCE_EXHAUSTED/i.test(text)) {
          throw new FatalTranslationError(`the daily quota of ${modelName} is used up (free-tier keys allow few requests a day). Run it again after the quota resets (it continues from where it stopped), or pass --model with another model.`);
        }
        // Failed requests also count toward the free daily quota. Use longer waits and at most two retries.
        if (!transient(error) || attempt > 2) throw error;
        output.warn(`[i18n] transient failure (${text.replace(/\s+/g, " ").slice(0, 160)}); retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  let summary: Awaited<ReturnType<typeof translateFiles>>;
  try {
    summary = await translateFiles({
      dir: messagesDir,
      locales: args.langs,
      mode: args.stale ? "stale" : "missing",
      complete,
      batchSize: args.batchSize,
      limit: args.limit,
      log: (m) => output.warn(`[i18n] ${m}`),
      shouldStop: () => (spentUsd() > args.maxCostUsd ? `the cost passed the limit of $${args.maxCostUsd}` : null),
    });
  } catch (error) {
    // Fatal failure: accepted translations and fingerprints are already saved.
    output.error(`\nusage so far: ${calls} call(s), ${inputTokens} input and ${outputTokens} output tokens = $${spentUsd().toFixed(4)}`);
    throw error;
  }
  for (const s of summary) output.log(`[i18n] ${s.locale}: ${s.added}/${s.keys} ${args.stale ? "re-translated" : "added"} (${s.calls} call(s), ${s.retried} key(s) retried)${s.stopped ? `; stopped: ${s.stopped}` : ""}`);

  output.log(`\nusage: ${calls} call(s), ${inputTokens} input tokens, ${outputTokens} output tokens (including thinking) = $${spentUsd().toFixed(4)} with ${engine}/${modelName}`);
  const failed = summary.flatMap((s) => Object.entries(s.failed).map(([key, problems]) => ({ locale: s.locale, key, problems })));
  for (const f of failed) output.error(`FAILED ${f.locale}/${f.key}: ${f.problems.join("; ")}`);
  const written = Object.fromEntries(ALL_LOCALES.flatMap((l) => (read(l) ? [[l, read(l)!] as const] : [])));
  const problems = [...checkMessages(written, { locales: args.langs }), ...checkStale(source, written, readHashes(messagesDir)!, args.langs)];
  // Count stale translations as failures only after --stale. Missing-key runs leave other stale translations for --check. With --limit, remaining keys are expected.
  const countStale = args.stale && args.limit === Infinity;
  const structural = problems.filter((p) => p.problem !== "missing" && (countStale || !p.problem.startsWith("stale")));
  for (const p of structural) output.error(`${p.locale}/${p.key}: ${p.problem}`);
  return failed.length === 0 && structural.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) runI18n(process.argv.slice(2)).then(code => process.exit(code)).catch((error: unknown) => {
  console.error(safeErrorText(error));
  process.exit(1);
});
