// Apply migrations for either PGlite or PostgreSQL.
// Production PostgreSQL does not migrate automatically at app startup. Run this before each deployment; Docker entrypoint invokes it.
// PostgreSQL advisory locking makes simultaneous runs safe: the second waits for the first to finish.
// Then recompute profiles.handle_key with the app's collation-independent logic. On collisions, fail with the conflicting names.
// For PGlite, stop the development server first; the data-directory lock rejects execution while it is running.
import { resolveDbConfig } from "../app/lib/db/client.server";
import { explainMigrationError, migrateDatabase } from "../app/lib/db/migrate.server";
import { safeErrorText } from "../app/lib/error-text.server";

const config = resolveDbConfig();
// Never display connection strings, which may contain passwords.
const target = config.kind === "pg" ? "PostgreSQL" : `PGlite (${config.dataDir})`;
try {
  const result = await migrateDatabase(config, { log: (message) => console.log(`[migrate] ${message}`) });
  if (result.fixed.length > 0) {
    console.log(`[migrate] recomputed handle_key for ${result.fixed.length} profile(s) whose stored key differed from the application's: ${result.fixed.map((h) => `"${h}"`).join(", ")}`);
  }
} catch (error) {
  const message = safeErrorText(error);
  console.error(`Migration failed on ${target}:`, message);
  const hint = explainMigrationError(`${message} ${error instanceof Error ? error.message : ""}`);
  if (hint) console.error(hint);
  process.exit(1);
}
console.log(`Migrations applied to ${target}.`);
process.exit(0);
