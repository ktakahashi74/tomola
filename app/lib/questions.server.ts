import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import type { StanceAttrInput } from "~/lib/stances";

// DB-reading helpers for question asks_stance topics. Attribute validation checkStanceAttributes is pure and does not access DB (app/lib/stances.ts),
// These helpers read the facts needed by that validation inside a transaction.

// Read whether the reply topic is a question and the alt_of target's state: the DB-dependent validation inputs.
// lockAltTarget at creation reads/locks the original with FOR NO KEY UPDATE to serialize with concurrent hiding/deletion. Order: alternative row (already taken by moderation/edit), then
// original-question row. Saving drafts does not lock; publication revalidates as creation.
export async function loadStanceAttrFacts(
  db: Db,
  input: { kind: "topic" | "reply"; threadId?: number | null; altOf?: number | null; lockAltTarget?: boolean },
): Promise<Pick<StanceAttrInput, "threadAsksStance" | "altTarget">> {
  const facts: Pick<StanceAttrInput, "threadAsksStance" | "altTarget"> = {};
  if (input.kind === "reply" && input.threadId) {
    const [topic] = await db
      .select({ asksStance: entries.asksStance })
      .from(entries)
      .where(and(eq(entries.id, input.threadId), eq(entries.kind, "topic")));
    facts.threadAsksStance = topic?.asksStance ?? false;
  }
  if (input.altOf) {
    const query = db
      .select({ kind: entries.kind, asksStance: entries.asksStance, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
      .from(entries)
      .where(eq(entries.id, input.altOf));
    const [target] = await (input.lockAltTarget ? query.for("no key update") : query);
    facts.altTarget = target
      ? { kind: target.kind as "topic" | "reply", asksStance: target.asksStance, deleted: target.deletedAt !== null, hidden: target.hiddenAt !== null }
      : null;
  }
  return facts;
}

// Advance question meta_changed_at to now without moving backward for twin-visible metadata changes (alternatives list or reply mark),
// so changes/manifest reflect them through the generated changed_at expression. Leave entries.updated_at unchanged.
// Call in the same transaction as the change.
// Never touch deleted/hidden questions: advancing changed_at past deletion/hiding could expose title/author as edited in the feed,
// contrary to hiding content. Placeholder twins show no observable alternatives-list change. Showing/restoring
// advances changed_at through moderated_at and exposes the list again.
export async function touchQuestion(db: Db, questionId: number, now: Date): Promise<void> {
  await db
    .update(entries)
    .set({ metaChangedAt: sql`greatest(coalesce(${entries.metaChangedAt}, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)` })
    .where(and(eq(entries.id, questionId), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
}

// If entryId is an alternative, touchQuestion on its original after creation, retitling, hiding/showing, deleting/restoring.
export async function touchAltOriginal(db: Db, entryId: number, now: Date): Promise<void> {
  const [row] = await db.select({ altOf: entries.altOf }).from(entries).where(eq(entries.id, entryId));
  if (row?.altOf != null) await touchQuestion(db, row.altOf, now);
}
