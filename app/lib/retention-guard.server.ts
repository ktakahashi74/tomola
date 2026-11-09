import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { retentionHold } from "~/lib/db/schema";

// The permanent singleton row makes enabling a hold wait for any short batch
// already in flight. Later batches see the hold before changing any records.
export async function withRetentionBatch<T>(db: Db, action: (tx: Db) => Promise<T>): Promise<T | null> {
  return db.transaction(async tx => {
    const [hold] = await tx.select().from(retentionHold).where(eq(retentionHold.id, 1)).for("share");
    if (!hold) throw new Error("Missing retention hold control row; cleanup stopped");
    if (hold.active) {
      console.log("[retention] preservation hold active; cleanup skipped");
      return null;
    }
    return action(tx);
  });
}
