import { safeErrorText } from "../app/lib/error-text.server.ts";
// Requeue translations: recover failed current-version jobs and suppressed primary translations. Title-only failures requeue only the title.
//   pnpm translations:requeue               With TRANSLATION_EAGER_SCOPE=readers (default), recover failures only; all also queues every missing pair.
//   pnpm translations:requeue --all-missing Queue every entry/language pair missing usable current primary title/body translations, including never-requested pairs.
//   pnpm translations:requeue --lang fr     Restrict targets to an enabled language (repeat --lang to select more).
//   pnpm translations:requeue --dry-run     Report target pairs and source character counts without queuing jobs.
//   pnpm translations:requeue --divergence  Also queue measure_divergence for unmeasured topics.
//   pnpm translations:requeue --include-flagged  Also retranslate near-copy results flagged untranslated_script/untranslated_similar. Skip by default: they are displayed and repeated billing often yields the same output.
//   pnpm translations:requeue --allow-fake  Without this, stop unchanged when primary is fake (no key), avoiding jobs producing fake 「[ja] 原文」 translations.
//                                           See app/lib/script-guards.ts. Use in development without keys.
// Only enqueue; dev/web workers execute. dedupe_key prevents duplicate unfinished jobs on repeated runs.
// Stop the development server first: PGlite cannot open the same data from multiple processes. Production PostgreSQL may remain running.
import { cliOutput, isMain, runCli, type CliOutput } from "./cli";
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { resolveEngines } from "../app/lib/llm/config.server";
import { ALLOW_FAKE_FLAG, fakeEngineRefusal } from "../app/lib/script-guards";
import { requeueTranslations } from "../app/lib/translations-requeue.server";
import { isLang, type Lang } from "../app/lib/languages";

const USAGE = `usage: pnpm translations:requeue [--all-missing] [--lang <tag>] [--dry-run] [--divergence] [--include-flagged] [${ALLOW_FAKE_FLAG}]`;

export async function runTranslationRequeue(args: string[], openDb: typeof getDb = getDb, output: CliOutput = cliOutput): Promise<number> {
  const known = new Set(["--all-missing", "--dry-run", "--divergence", "--include-flagged", ALLOW_FAKE_FLAG]);
  const langs: Lang[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lang") {
      const tag = args[++i];
      if (!isLang(tag)) {
        output.error(`--lang requires a supported language tag\n${USAGE}`);
        return 1;
      }
      if (!langs.includes(tag)) langs.push(tag);
    } else if (!known.has(args[i])) {
      output.error(`unknown option: ${args[i]}\n${USAGE}`);
      return 1;
    }
  }

  // Check engines before opening the database. fake stops without touching anything; invalid settings, such as an explicitly chosen engine lacking a key, also stop here.
  let primaryId: string;
  try {
    primaryId = resolveEngines().primary.id;
  } catch (error) {
    output.error(safeErrorText(error));
    return 1;
  }
  const refusal = fakeEngineRefusal({ script: "translations:requeue", engine: "primary translation", engineId: primaryId, args });
  if (refusal) {
    output.error(refusal);
    return 1;
  }

  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await openDb();
  } catch (error) {
    // A running development server causes a lock error; no stack trace needed.
    output.error(safeErrorText(error));
    return 1;
  }
  let result: Awaited<ReturnType<typeof requeueTranslations>>;
  try {
    result = await requeueTranslations(db, { allMissing: args.includes("--all-missing") ? true : undefined, langs: langs.length ? langs : undefined,
      dryRun: args.includes("--dry-run"), divergence: args.includes("--divergence"), includeFlagged: args.includes("--include-flagged") });
  } catch (error) {
    output.error(safeErrorText(error));
    return 1;
  }
  output.log(`checked ${result.entries} entries`);
  if (result.dryRun) {
    output.log(`dry run: ${result.dryRun.targets} (post x language) translation(s) would be queued (${result.dryRun.chars} source characters); nothing was queued`);
    return 0;
  }
  output.log(`queued ${result.translate} translate_entry job(s)`);
  if (args.includes("--divergence")) {
    if (result.divergenceSkipped) output.log(`divergence: skipped (${result.divergenceSkipped})`);
    else output.log(`queued ${result.divergence} measure_divergence job(s)`);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exit(await runCli(() => runTranslationRequeue(process.argv.slice(2))));
