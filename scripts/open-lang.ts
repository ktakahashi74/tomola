import { runCli } from "./cli";
// pnpm langs:open <tag> [--dry-run] [--allow-fake] [--allow-unreviewed-glossary]: queue translation jobs for the existing posts into a language that was just added to ENABLED_LANGS.
//   <tag>          ja, en, fr, de, zh-Hant, zh-Hans, ko, th or vi. It must be in ENABLED_LANGS already (add it, restart the app, then run this: in production,
//                  docker compose exec app pnpm langs:open fr).
//   --dry-run      queue nothing; show how many (post x language) translations would be queued and a rough cost estimate.
//   --allow-fake   run even when the primary translation engine is fake (development without a key; refused otherwise, app/lib/script-guards.ts).
//   --allow-unreviewed-glossary  deliberately proceed while active glossary entries targeting <tag> still need review; otherwise this stops (also on a dry run).
// The interface strings of the language must have been checked by a native speaker (no missing, stale or unverified public keys), or this stops.
// The glossary candidates of the target language must also have been reviewed by its speakers; the explicit glossary override does not bypass the interface or engine checks.
// It only queues: the worker (the web process) makes the translations, within the monthly budget (a job that hits the budget stays queued).
// Stop a development server first (PGlite cannot be opened by two processes; a PostgreSQL in production can).
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { runOpenLang } from "../app/lib/langs-open.server";

process.exit(await runCli(() => runOpenLang(process.argv.slice(2), { getDb })));
