import { and, eq } from "drizzle-orm";
import type { Tx } from "~/lib/db/client.server";
import { draftReceipts } from "~/lib/db/schema";

export type DraftPublication = { id: number; threadId: number };

// A consumed draft and its receipt must commit together. There is no body in the receipt.
export async function finishDraftReceipt(tx: Tx, draftId: number, published: DraftPublication | null, now = new Date()) {
  await tx.update(draftReceipts).set({
    state: published ? "published" : "discarded",
    entryId: published?.id ?? null,
    threadId: published?.threadId ?? null,
    finishedAt: now,
  }).where(and(eq(draftReceipts.draftId, draftId), eq(draftReceipts.state, "pending")));
}
