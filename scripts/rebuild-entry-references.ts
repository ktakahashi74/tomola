import { runCli } from "./cli";
// Rebuild the derived reference index from original posts, in bounded batches.
// Default: dry-run. --write explicitly applies changes. Stop a PGlite server
// before opening its directory; use the configured database for deployment.
// pnpm exec tsx scripts/rebuild-entry-references.ts --from-id 1 --to-id 1000 [--limit 100] [--write]
import { closeDb, openPgDb, openPgliteDb, resolveDbConfig } from "../app/lib/db/client.server";
import { rebuildEntryReferences } from "../app/lib/related-discussions.server";

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let write = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--write" && !write) { write = true; continue; }
    if (!["--from-id", "--to-id", "--limit"].includes(arg) || options.has(arg) || !/^[1-9]\d*$/.test(args[i + 1] ?? "")) throw new Error("usage: rebuild-entry-references --from-id N --to-id N [--limit 100] [--write]");
    options.set(arg, args[++i]);
  }
  const fromId = Number(options.get("--from-id")), toId = Number(options.get("--to-id"));
  const limit = Number(options.get("--limit") ?? 100);
  if (!Number.isSafeInteger(fromId) || fromId < 1 || !Number.isSafeInteger(toId) || toId < fromId || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Provide a valid --from-id and --to-id range, and --limit between 1 and 1000.");
  // Migrations and other backfills are separate operations, including dry-run.
  const config = resolveDbConfig();
  const db = config.kind === "pg" ? await openPgDb(config.url, { statementTimeoutMs: 0 }) : await openPgliteDb(config.dataDir, { migrate: false });
  try {
    const result = await rebuildEntryReferences(db, { fromId, toId, limit, write });
    console.log(JSON.stringify({ mode: write ? "write" : "dry-run", fromId, toId, ...result }));
  } finally { await closeDb(db); }
}

process.exitCode = await runCli(main);
