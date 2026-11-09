import { safeErrorText } from "../app/lib/error-text.server.ts";
// Requeue translations: recover entries without translations, failed jobs, and disagreement measurement skipped during degraded budget.
//   pnpm translations:requeue               Queue translate_entry for entry/language pairs missing current primary title/body translations.
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

export async function runTranslationRequeue(args: string[], openDb: typeof getDb = getDb, output: CliOutput = cliOutput): Promise<number> {
  const known = new Set(["--divergence", "--include-flagged", ALLOW_FAKE_FLAG]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    output.error(`unknown option: ${unknown.join(" ")}\nusage: pnpm translations:requeue [--divergence] [--include-flagged] [${ALLOW_FAKE_FLAG}]`);
    return 1;
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
  const result = await requeueTranslations(db, { divergence: args.includes("--divergence"), includeFlagged: args.includes("--include-flagged") });
  output.log(`checked ${result.entries} entries`);
  output.log(`queued ${result.translate} translate_entry job(s)`);
  if (args.includes("--divergence")) {
    if (result.divergenceSkipped) output.log(`divergence: skipped (${result.divergenceSkipped})`);
    else output.log(`queued ${result.divergence} measure_divergence job(s)`);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exit(await runCli(() => runTranslationRequeue(process.argv.slice(2))));
