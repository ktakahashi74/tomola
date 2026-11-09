import { runCli } from "./cli";
import path from "node:path";
import { closeDb, openPgDb, openPgliteDb, resolveDbConfig } from "../app/lib/db/client.server";
import { isLang, type Lang } from "../app/lib/languages";
import { exportSite } from "../app/lib/site-export.server";

async function main() {
  const args = process.argv.slice(2);
  let outDir: string | undefined, langs: Lang[] | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && !outDir && args[i + 1] && !args[i + 1].startsWith("--")) outDir = args[++i];
    else if (args[i] === "--lang" && !langs && args[i + 1]) {
      const tags = args[++i].split(",");
      if (!tags.every(isLang)) throw new Error("Use comma-separated supported language tags");
      langs = tags as Lang[];
    } else throw new Error("usage: pnpm site:export --out <directory> [--lang ja,en]");
  }
  if (!outDir) throw new Error("usage: pnpm site:export --out <directory> [--lang ja,en]");
  const config = resolveDbConfig();
  if (config.kind === "pglite" && config.dataDir) {
    const output = path.resolve(outDir), data = path.resolve(config.dataDir);
    const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
    if (contains(output, data) || contains(data, output)) throw new Error("The output and PGlite data directories must not overlap");
  }
  // Opening must not migrate or backfill. Exporting is a read-only operation.
  const db = config.kind === "pg" ? await openPgDb(config.url, { statementTimeoutMs: 0 }) : await openPgliteDb(config.dataDir, { migrate: false });
  try { console.log(JSON.stringify(await exportSite(db, { outDir, langs }))); }
  finally { await closeDb(db); }
}

process.exitCode = await runCli(main);
