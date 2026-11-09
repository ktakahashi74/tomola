// Database configuration is pure: startup checks may import it before a driver, worker or database is initialized.
export const DEFAULT_PGLITE_DATA_DIR = "./.data/pglite";

export type DbConfig =
  | { kind: "pglite"; dataDir: string | undefined; legacy?: boolean }
  | { kind: "pg"; url: string };

export function databasePoolMax(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DATABASE_POOL_MAX?.trim() || "10";
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 100");
  }
  return value;
}

// Driver startup parameters apply to every connection, including newly replaced pool clients.
// Migrations and operator scripts opt out of the application statement deadline explicitly.
export function pgPoolOptions(env: Record<string, string | undefined> = process.env, opts: { max?: number; statementTimeoutMs?: number; lockTimeoutMs?: number } = {}) {
  return {
    max: opts.max ?? databasePoolMax(env),
    connectionTimeoutMillis: 10_000,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
    ...(opts.lockTimeoutMs === undefined ? {} : { lock_timeout: opts.lockTimeoutMs }),
  };
}

// PostgreSQL URLs select node-postgres; other DATABASE_URL values retain the legacy PGlite path only when no explicit PGLITE_DATA_DIR is set.
export function resolveDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const url = env.DATABASE_URL?.trim() || undefined;
  if (url && /^postgres(ql)?:\/\//i.test(url)) return { kind: "pg", url };
  const dir = env.PGLITE_DATA_DIR?.trim() || undefined;
  if (dir) return { kind: "pglite", dataDir: dir };
  if (url) return { kind: "pglite", dataDir: url, legacy: true };
  return { kind: "pglite", dataDir: DEFAULT_PGLITE_DATA_DIR };
}
