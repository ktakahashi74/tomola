import { closeDb, openPgDb, openPgliteDb, resolveDbConfig, type Db } from "../app/lib/db/client.server";
import { rebuildTopicListingStats } from "../app/lib/topic-listing-stats.server";
import { isMain, runCli } from "./cli";

async function openListingDb() {
  const config = resolveDbConfig();
  // Applying migrations is a separate operation, including for previews.
  return config.kind === "pg" ? openPgDb(config.url, { statementTimeoutMs: 0 }) : openPgliteDb(config.dataDir, { migrate: false });
}
export async function runTopicListingRebuild(args: string[], deps: { open?: () => Promise<Db>; close?: (db: Db) => Promise<void>; output?: Pick<Console, "log"> } = {}) {
  if (args.length && (args.length !== 1 || args[0] !== "--write")) throw new Error("usage: rebuild-topic-listing-stats [--write]");
  const db = await (deps.open ?? openListingDb)();
  try { (deps.output ?? console).log(JSON.stringify(await rebuildTopicListingStats(db, { write: args[0] === "--write" }))); }
  finally { await (deps.close ?? closeDb)(db); }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(() => runTopicListingRebuild(process.argv.slice(2)));
