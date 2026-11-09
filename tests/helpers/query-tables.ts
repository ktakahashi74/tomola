import { getTableName, type Table } from "drizzle-orm";
import { vi } from "vitest";
import type { Db } from "~/lib/db/client.server";

// Observe real selects without replacing their results or executing any extra queries.
export function selectedTables(db: Db) {
  const tables = new Set<string>();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const select = db.select.bind(db);
  const spy = vi.spyOn(db, "select").mockImplementation(((fields: Parameters<typeof select>[0]) => {
    const query = select(fields);
    const from = query.from.bind(query);
    vi.spyOn(query, "from").mockImplementation(((table: Table) => {
      tables.add(getTableName(table));
      const result = from(table);
      const where = result.where.bind(result);
      vi.spyOn(result, "where").mockImplementation(((condition: Parameters<typeof where>[0]) => {
        const query = where(condition);
        queries.push(query.toSQL());
        return query;
      }) as typeof result.where);
      return result;
    }) as typeof query.from);
    return query;
  }) as typeof db.select);
  return { tables, queries, restore: () => spy.mockRestore() };
}
