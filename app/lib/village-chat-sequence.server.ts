import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatSequences } from "./db/schema";

// The sole sequence allocator for every chat mutation. Acquire existing-row
// locks first; the sequence row is always the last row locked.
// Reserving a range returns its last number; every changed message receives a
// distinct number in that range before the surrounding transaction commits.
export async function nextChatSequence(db: Db, villageId: string, count = 1): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid chat sequence count");
  await db.insert(chatSequences).values({ villageId }).onConflictDoNothing();
  const [row] = await db.update(chatSequences).set({ seq: sql`${chatSequences.seq} + ${count}` }).where(eq(chatSequences.villageId, villageId)).returning({ seq: chatSequences.seq });
  if (!Number.isSafeInteger(row.seq)) throw new Error("Chat sequence exceeded safe integer range");
  return row.seq;
}
