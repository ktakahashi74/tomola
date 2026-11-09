import { safeErrorText } from "../app/lib/error-text.server.ts";
// Requeue entry embeddings: recover missing embeddings, including after model changes or failed jobs.
//   pnpm embeddings:backfill    Queue embed_entry for entries missing current-revision embeddings from the current EMBEDDING_MODEL (fake without a key).
//   pnpm embeddings:backfill --prune-other-models    Also delete other-model rows left by model changes. Search/observations do not use them; delete if no model rollback is planned.
//   pnpm embeddings:backfill --allow-fake    Without this, stop without changes when the engine is fake (no key), preventing fake from becoming the current model and deleting
//                                            all real embeddings (app/lib/script-guards.ts). Use in development without keys.
// Only enqueue; workers in dev/web processes execute. Record cost in llm_usage under purpose=embed and wait while budget is stopped.
// dedupe_key prevents duplicate unfinished jobs on repeated runs. Do not queue deleted/hidden entries.
// Stop the development server first: PGlite cannot open the same data from multiple processes. Production PostgreSQL may remain running.
import { cliOutput, isMain, runCli, type CliOutput } from "./cli";
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { pruneOtherModels, requeueEmbeddings } from "../app/lib/embeddings.server";
import { resolveEmbeddingEngine } from "../app/lib/llm/index.server";
import { ALLOW_FAKE_FLAG, fakeEngineRefusal } from "../app/lib/script-guards";

export async function runEmbeddingBackfill(args: string[], openDb: typeof getDb = getDb, output: CliOutput = cliOutput): Promise<number> {
  const known = new Set(["--prune-other-models", ALLOW_FAKE_FLAG]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    output.error(`unknown option: ${unknown.join(" ")}\nusage: pnpm embeddings:backfill [--prune-other-models] [${ALLOW_FAKE_FLAG}]`);
    return 1;
  }

  // Check the engine before opening the database; fake stops without touching anything.
  let engine: ReturnType<typeof resolveEmbeddingEngine>;
  try {
    engine = resolveEmbeddingEngine();
  } catch (error) {
    output.error(safeErrorText(error));
    return 1;
  }
  const refusal = fakeEngineRefusal({ script: "embeddings:backfill", engine: "embedding", engineId: engine.id, args });
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
  const result = await requeueEmbeddings(db, engine.model);
  output.log(`model: ${engine.id}/${engine.model}`);
  output.log(`checked ${result.entries} entries`);
  output.log(`queued ${result.queued} embed_entry job(s)`);
  if (args.includes("--prune-other-models")) output.log(`deleted ${await pruneOtherModels(db, engine.model)} embedding(s) of other models`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await runCli(() => runEmbeddingBackfill(process.argv.slice(2))));
