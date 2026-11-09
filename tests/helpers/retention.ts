import { getTableName, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { expect } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { RETENTION_BATCH_SIZE } from "~/lib/retention";

// Audit actual changed rows grouped by database transaction, across all tables.
export async function auditRetentionTransactions(db: Db, tables: AnyPgTable[]) {
  await db.execute(sql`create table retention_changes (transaction_id bigint, table_name text)`);
  await db.execute(sql`create function audit_retention_change() returns trigger language plpgsql as $$ begin
    insert into retention_changes values (txid_current(), TG_TABLE_NAME);
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end $$`);
  for (const table of tables) {
    const name = getTableName(table);
    await db.execute(sql`create trigger audit_retention_change after delete or update on ${sql.identifier(name)} for each row execute function audit_retention_change()`);
  }
}

export async function expectBoundedTransactions(db: Db, total: number) {
  const { rows } = await db.execute(sql`select count(*)::int as changed from retention_changes group by transaction_id`) as { rows: { changed: number }[] };
  expect(rows.reduce((sum, row) => sum + row.changed, 0)).toBe(total);
  expect(Math.max(...rows.map(row => row.changed))).toBeLessThanOrEqual(RETENTION_BATCH_SIZE);
}
