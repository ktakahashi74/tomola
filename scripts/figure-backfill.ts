import fs from "node:fs";
import { backfillFigures } from "../app/lib/figure-backfill.server";
import { closeDb, openPgDb, openPgliteDb, resolveDbConfig, type Db } from "../app/lib/db/client.server";
import { figureTranslationEnabled } from "../app/lib/figure-reading.server";
import { safeErrorText } from "../app/lib/error-text.server";
import { cliOutput, isMain, runCli, type CliOutput } from "./cli";

async function openExistingDb(env: NodeJS.ProcessEnv): Promise<Db> {
  const config = resolveDbConfig(env);
  if (config.kind === "pg") return openPgDb(config.url, { migrate: false, max: 1, statementTimeoutMs: 0 });
  if (!config.dataDir || !fs.existsSync(config.dataDir)) throw new Error("An existing migrated database is required");
  return openPgliteDb(config.dataDir, { migrate: false });
}

export async function runFigureBackfill(args: string[], env = process.env, openDb: () => Promise<Db> = () => openExistingDb(env), output: CliOutput = cliOutput): Promise<number> {
  if (args.length === 1 && args[0] === "--help") { output.log("usage: pnpm figures:backfill [--reread-rejected] [--enqueue] (default: read-only cost preview)"); return 0; }
  if (args.some(arg => arg !== "--enqueue" && arg !== "--reread-rejected")) { output.error("usage: pnpm figures:backfill [--reread-rejected] [--enqueue]"); return 1; }
  const enqueue = args.includes("--enqueue");
  if (enqueue && !figureTranslationEnabled(env)) { output.error("FIGURE_TRANSLATION=1 is required to enqueue figures"); return 1; }
  let db: Db | undefined;
  try { db = await openDb(); output.log(JSON.stringify(await backfillFigures(db, { enqueue, rereadRejected: args.includes("--reread-rejected"), env }), null, 2)); return 0; }
  catch (error) { output.error(safeErrorText(error)); return 1; }
  finally { if (db) await closeDb(db); }
}

if (isMain(import.meta.url)) process.exit(await runCli(() => runFigureBackfill(process.argv.slice(2))));
