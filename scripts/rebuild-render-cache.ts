import { runCli } from "./cli";
import { safeErrorText } from "../app/lib/error-text.server.ts";
// Rebuilds the saved renders (the html of posts and of the translations that are shown, with the card version) that are at another version than RENDER_VERSION.
//   pnpm render:rebuild              rebuilds them all, newest topics first, until none is left
//   pnpm render:rebuild --dry-run    only counts the rows that would be rebuilt (nothing is written)
// Run it after a deploy that raised RENDER_VERSION (app/lib/markdown.server.ts), after the migrations; the worker also queues the same rebuild when it starts (docs/deploy.md).
// It only renders: no API is called. In production run it inside the app container. With PGlite (development) stop the dev server first (PGlite opens its data from one process only).
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { RENDER_VERSION } from "../app/lib/markdown.server";
import { countStaleRenderCache, rebuildRenderCache } from "../app/lib/render-cache.server";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`unknown option: ${unknown.join(" ")}\nusage: pnpm render:rebuild [--dry-run]`);
    process.exit(1);
  }

  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (error) {
    // With the dev server running, PGlite's lock gives an error; no stack trace is needed.
    console.error(safeErrorText(error));
    process.exit(1);
  }

  const stale = await countStaleRenderCache(db);
  console.log(`RENDER_VERSION ${RENDER_VERSION}: ${stale.entries} post(s) and ${stale.translations} translation(s) at another version`);
  if (args.includes("--dry-run")) process.exit(0);

  let rebuiltEntries = 0;
  let rebuiltTranslations = 0;
  let remaining = stale.entries + stale.translations;
  while (remaining > 0) {
    const result = await rebuildRenderCache(db, { maxRows: 500 });
    rebuiltEntries += result.entries;
    rebuiltTranslations += result.translations;
    remaining = result.remaining;
    console.log(`rebuilt ${rebuiltEntries} post(s) and ${rebuiltTranslations} translation(s); ${remaining} left`);
    // Nothing could be saved in this pass (the rows were edited while they were rendered): stop instead of spinning; run it again.
    if (result.entries + result.translations === 0) break;
  }
  if (remaining > 0) {
    console.error(`${remaining} row(s) are still at another version (they were edited while being rebuilt); run the command again`);
    process.exit(1);
  }
  process.exit(0);
}

process.exitCode = await runCli(main);
