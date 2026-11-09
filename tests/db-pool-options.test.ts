import { expect, it } from "vitest";
import { databasePoolMax, pgPoolOptions } from "~/lib/db/config.server";
import { closeDb, openPgDb } from "~/lib/db/client.server";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";

it("bounds connection acquisition and queries while allowing long operator work", () => {
  expect(pgPoolOptions({})).toMatchObject({ max: 10, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 });
  expect(pgPoolOptions({ DATABASE_POOL_MAX: "24" })).toMatchObject({ max: 24 });
  expect(pgPoolOptions({}, { statementTimeoutMs: 0 })).toMatchObject({ statement_timeout: 0 });
});

it.skipIf(!REAL_PG_URL)("applies startup deadlines on real PostgreSQL and explicitly disables a database default for operator work", { tags: ["postgres"] }, async () => {
  const scratch = await createScratchDb({ migrate: false });
  try {
    const admin = await scratch.admin();
    await admin.query(`alter database "${scratch.name}" set statement_timeout = '1s'`);
    for (const [opts, expected] of [[{}, "30s"], [{ statementTimeoutMs: 0 }, "0"], [{ migrate: true }, "0"]] as const) {
      const db = await openPgDb(scratch.url, opts);
      try {
        const rows = await db.execute("select current_setting('statement_timeout') as statement, current_setting('idle_in_transaction_session_timeout') as idle, current_setting('lock_timeout') as lock") as { rows: Array<{ statement: string; idle: string; lock: string }> };
        expect(rows.rows[0]).toMatchObject({ statement: expected, idle: "1min", ...(("migrate" in opts) ? { lock: "10s" } : {}) });
      } finally { await closeDb(db); }
    }
  } finally { await scratch.drop(); }
});

it.each(["0", "-1", "1.5", "garbage", "101"])("rejects an invalid pool limit %s", raw => {
  expect(() => databasePoolMax({ DATABASE_POOL_MAX: raw })).toThrow(/DATABASE_POOL_MAX/);
});
