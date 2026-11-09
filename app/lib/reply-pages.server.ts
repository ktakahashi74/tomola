import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries } from "./db/schema";
import { pageCount, REPLIES_PER_PAGE } from "./pagination";

// Rank before filtering targets: deleted and hidden rows retain page positions.
export async function replyPagesOf(db: Db, targets: readonly { threadId: number; id: number }[]): Promise<Map<number, number>> {
  if (!targets.length) return new Map();
  const ranked = db.select({ id: entries.id, threadId: entries.threadId,
    position: sql<number>`row_number() over (partition by ${entries.threadId} order by ${entries.createdAt}, ${entries.id})`.as("position"),
  }).from(entries).where(and(eq(entries.kind, "reply"), inArray(entries.threadId, [...new Set(targets.map(t => t.threadId))]))).as("ranked");
  const rows = await db.select().from(ranked).where(inArray(ranked.id, targets.map(t => t.id)));
  const expected = new Map(targets.map(t => [t.id, t.threadId]));
  return new Map(rows.filter(r => expected.get(r.id) === r.threadId).map(r => [r.id, pageCount(Number(r.position), REPLIES_PER_PAGE)]));
}
