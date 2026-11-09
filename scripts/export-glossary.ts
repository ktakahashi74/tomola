import { safeErrorText } from "../app/lib/error-text.server.ts";
import { cliOutput, isMain, runCli, type CliOutput } from "./cli";
// Glossary export: all active, undeleted rows in import-compatible YAML (pnpm glossary:import). Include all nine languages, row-oriented, in glossary-version order.
// Exclude timestamps, editors, and history, yielding identical bytes for identical content. Read history through /glossary or /glossary.md. No API calls.
//
//   pnpm glossary:export                    Write to stdout.
//   pnpm glossary:export --out glossary.yaml   Write to a file without leaving corruption on partial failure.
//
// In production, run inside the app container: docker compose exec app pnpm glossary:export > glossary.yaml
// Back up before import (docs/deploy.md). Stop the development server first because PGlite cannot open the same data in multiple processes.
import fs from "node:fs";
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { buildGlossaryExport } from "../app/lib/glossary-io.server";

export async function runGlossaryExport(args: string[], openDb: typeof getDb = getDb, output: CliOutput = cliOutput): Promise<number> {
  let out: string | undefined;
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) out = args[++i];
    else if (args[i].startsWith("--out=") && args[i].length > "--out=".length) out = args[i].slice("--out=".length);
    else bad = true;
  }
  if (bad) {
    output.error("usage: pnpm glossary:export [--out <file>]");
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
  const text = await buildGlossaryExport(db);
  if (out === undefined) {
    // Exiting before pipe writes complete truncates output; wait for completion before exiting.
    await output.write(text);
    return 0;
  } else {
    const temporary = `${out}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, out);
    output.error(`wrote ${out}`);
    return 0;
  }
}

if (isMain(import.meta.url)) process.exit(await runCli(() => runGlossaryExport(process.argv.slice(2))));
