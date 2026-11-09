import { sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";

// Read topology only, retaining hidden/deleted ancestors without their content.
// UNION also terminates corrupt cycles, and avoids walking a shared ancestor twice.
export async function loadReplyParents(db: Db, threadId: number, displayedIds?: readonly number[]): Promise<{ id: number; parentId: number | null }[]> {
  if (displayedIds?.length === 0) return [];
  const result = await db.execute(sql`with recursive ancestors(id, parent_id) as (
    select id, parent_id from entries where thread_id = ${threadId} and kind = 'reply'
      ${displayedIds ? sql`and id in (${sql.join(displayedIds.map(id => sql`${id}`), sql`, `)})` : sql``}
    union
    select e.id, e.parent_id from entries e join ancestors a on e.id = a.parent_id
      where e.thread_id = ${threadId} and e.kind = 'reply'
  ) select id, parent_id as "parentId" from ancestors`);
  const rows = (result as { rows: { id: string | number; parentId: string | number | null }[] }).rows;
  return rows.map(row => ({ id: Number(row.id), parentId: row.parentId === null ? null : Number(row.parentId) }));
}
