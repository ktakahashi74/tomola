import { hasStanceConsent } from "~/lib/trial-consent.server";
import { and, asc, count, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, stanceChanges, stances, votes } from "~/lib/db/schema";
import type { TitleDisplay } from "~/lib/entry-display.server";
import type { Area, Lang } from "~/lib/languages";
import { canSeeHidden, type Viewer } from "~/lib/roles.server";
import type { Position } from "~/lib/stances";

// Stances: register/change/withdraw/delete unnamed one-tap three-way choices on asks_stance topics.
// Never disclose who chose which stance except to that member. Read only own rows via loadOwnStances/listOwnStanceRecords; others are counted
// only by distribution.server.ts, returning totals/language counts.
//
// Global lock order: member profile → question entry → translation report. Every stance-changing operation first locks the profile
// FOR UPDATE (setStance, deleteStanceRecord, deleteAllStanceRecords, changeHomeArea, exclusion). Then question FOR NO KEY UPDATE,
// serializing with edits/replies/moderation/author deletion that take the same or stronger lock, without conflicting with FK FOR KEY SHARE checks.
//
// Prevent inference from timestamps: register/change/withdraw never advance question updated_at, last_activity_at or generated changed_at.
// Lock time stance_locked_at is excluded from changed_at's expression.

// Version equals stance_changes row count per question/member; register/change/withdraw increments it, never reset by withdrawing/removing the current row. Detects stale screens.
export type StanceState = { position: Position | null; version: number };

// Viewer's own stance/version for every supplied question id. Never read others' stances.
export async function loadOwnStances(db: Db, userId: string, questionIds: readonly number[]): Promise<Map<number, StanceState>> {
  const out = new Map<number, StanceState>();
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return out;
  const [rows, changeRows] = await Promise.all([
    db
      .select({ questionId: stances.questionId, position: stances.position, version: stances.version })
      .from(stances)
      .where(and(eq(stances.userId, userId), inArray(stances.questionId, ids))),
    db
      .select({ questionId: stanceChanges.questionId, n: count() })
      .from(stanceChanges)
      .where(and(eq(stanceChanges.userId, userId), inArray(stanceChanges.questionId, ids)))
      .groupBy(stanceChanges.questionId),
  ]);
  const current = new Map(rows.map((r) => [r.questionId, r]));
  const changes = new Map(changeRows.map((r) => [r.questionId, Number(r.n)]));
  for (const id of ids) {
    const row = current.get(id);
    out.set(id, row ? { position: row.position as Position, version: row.version } : { position: null, version: changes.get(id) ?? 0 });
  }
  return out;
}

// The one rule for a trigger of a stance change (the post "Reconsider my stance" came from). A post may be the trigger for this member and this question only if all of these hold:
// the post is the question itself or one of its replies, neither deleted nor hidden; the member pressed Insightful on it; and it has not been the trigger of a change of this member's
// stance on this question before (once only: ?review= stays in the URL after the change, and without this rule every later change from the same page would be recorded with the same post,
// which pollutes the append-only history and the "update across languages" metric). loadReviewTrigger (what the stance panel carries) and setStance (the final check) both use it.
// It says nothing about the stance itself: whether a stance is held, and that a withdrawal never has a trigger, are checked by the callers.
async function usableTrigger(db: Db, userId: string, questionId: number, entryId: number): Promise<{ id: number; authorArea: Area | null } | null> {
  const [post] = await db
    .select({ id: entries.id, authorArea: entries.authorArea })
    .from(entries)
    .innerJoin(votes, and(eq(votes.entryId, entries.id), eq(votes.voterId, userId)))
    .where(
      and(
        eq(entries.id, entryId),
        sql`(${entries.id} = ${questionId} or ${entries.threadId} = ${questionId})`,
        isNull(entries.deletedAt),
        isNull(entries.hiddenAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(stanceChanges)
            .where(and(eq(stanceChanges.userId, userId), eq(stanceChanges.questionId, questionId), eq(stanceChanges.triggerEntryId, entryId))),
        ),
      ),
    );
  return post ? { id: post.id, authorArea: (post.authorArea as Area | null) ?? null } : null;
}

// The post that "Reconsider my stance" came from (?review=<post> on the question page), if it may be the trigger (usableTrigger) and the member holds a stance on the question now.
// Otherwise null (the parameter is ignored, never an error). It only decides whether the stance panel carries the post as `trigger`; setStance checks again when the stance is sent
// (step 6), so a hand-made form cannot fake a trigger either, and a page that was loaded before an earlier change cannot reuse it.
export async function loadReviewTrigger(db: Db, userId: string, questionId: number, entryId: number): Promise<number | null> {
  const [held] = await db.select({ position: stances.position }).from(stances).where(and(eq(stances.questionId, questionId), eq(stances.userId, userId)));
  if (!held) return null;
  return (await usableTrigger(db, userId, questionId, entryId))?.id ?? null;
}

export type SetStanceInput = {
  questionId: number;
  // null means withdrawal.
  position: Position | null;
  // Version displayed by the screen, for stale-screen detection.
  expectedVersion: number;
  // Trigger post from 「立場を見直す」: loadReviewTrigger validates thread ?review=, then StancePanel passes it to /stance.
  triggerEntryId?: number | null;
};
export type SetStanceResult =
  | { ok: true; changed: boolean; position: Position | null; version: number }
  | { ok: false; error: "conflict"; position: Position | null; version: number }
  | { ok: false; error: "not_found" | "not_a_question" | "hidden" | "no_profile" | "consent_required" };

// Register/change/withdraw in one transaction, preserving profile → question lock order; never touch mistranslation-report rows.
export async function setStance(db: Db, userId: string, input: SetStanceInput, opts: { now?: Date } = {}): Promise<SetStanceResult> {
  const now = opts.now ?? new Date();
  const { questionId, position } = input;
  return db.transaction(async (tx) => {
    // 1. Lock member and read area. Every operation changing their stances starts here, serializing per member.
    const [profile] = await tx.select({ homeArea: profiles.homeArea, stanceConsentAt: profiles.stanceConsentAt, stanceConsentVersion: profiles.stanceConsentVersion }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!profile) return { ok: false as const, error: "no_profile" as const };
    if (position !== null && !hasStanceConsent(profile)) return { ok: false as const, error: "consent_required" as const };
    const area = profile.homeArea as Area;
    // 2. Question row: missing/deleted gives not_found, non-question not_a_question. Hidden questions permit withdrawal but not registration/change.
    const [question] = await tx
      .select({ kind: entries.kind, asksStance: entries.asksStance, authorId: entries.authorId, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt, stanceLockedAt: entries.stanceLockedAt })
      .from(entries)
      .where(eq(entries.id, questionId))
      .for("no key update");
    if (!question || question.deletedAt) return { ok: false as const, error: "not_found" as const };
    if (question.kind !== "topic" || !question.asksStance) return { ok: false as const, error: "not_a_question" as const };
    if (question.hiddenAt && position !== null) return { ok: false as const, error: "hidden" as const };
    // 3. Current stance/version from stances, or stance_changes row count if absent.
    const [row] = await tx
      .select({ position: stances.position, version: stances.version })
      .from(stances)
      .where(and(eq(stances.questionId, questionId), eq(stances.userId, userId)));
    let currentPosition: Position | null = null;
    let version: number;
    if (row) {
      currentPosition = row.position as Position;
      version = row.version;
    } else {
      const [{ n }] = await tx.select({ n: count() }).from(stanceChanges).where(and(eq(stanceChanges.questionId, questionId), eq(stanceChanges.userId, userId)));
      version = Number(n);
    }
    // 4. Same stance is a no-op, without a duplicate record. Check before version comparison to avoid conflicts after double presses.
    if (position === currentPosition) return { ok: true as const, changed: false, position: currentPosition, version };
    // 5. Reject stale-screen submissions with current stance/version.
    if (input.expectedVersion !== version) return { ok: false as const, error: "conflict" as const, position: currentPosition, version };
    // 6. Use only usableTrigger-eligible posts: visible/undeleted in the question thread, Insightful (「なるほど」) pressed by this member, never previously used
    //    for this member/question's change. Never attach to withdrawal; invalid candidates become no trigger, not errors, preventing crafted URLs from manipulating metrics.
    let triggerEntryId: number | null = null;
    let triggerArea: Area | null = null;
    if (position !== null && input.triggerEntryId != null) {
      const trigger = await usableTrigger(tx, userId, questionId, input.triggerEntryId);
      if (trigger) {
        triggerEntryId = trigger.id;
        triggerArea = trigger.authorArea;
      }
    }
    // 7. New version=current+1. Withdrawal deletes the row; otherwise insert/update.
    const newVersion = version + 1;
    if (position === null) {
      await tx.delete(stances).where(and(eq(stances.questionId, questionId), eq(stances.userId, userId)));
    } else {
      await tx
        .insert(stances)
        .values({ questionId, userId, position, area, version: newVersion, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [stances.questionId, stances.userId], set: { position, area, version: newVersion, updatedAt: now } });
    }
    // 8. Append-only history; area snapshots the member's area at change time and never changes later.
    await tx.insert(stanceChanges).values({ questionId, userId, fromPosition: currentPosition, toPosition: position, triggerEntryId, triggerArea, area, createdAt: now });
    // 9. Lock: first non-author member stance sets lock time. Author's own stance does not. Never clear it after withdrawal,
    //    personal-record deletion, moderation hide/delete or appeal restore. Excluded members also lock it because exclusion may be reversed on appeal.
    if (position !== null && userId !== question.authorId && question.stanceLockedAt === null) {
      await tx.update(entries).set({ stanceLockedAt: now }).where(and(eq(entries.id, questionId), isNull(entries.stanceLockedAt)));
    }
    return { ok: true as const, changed: true, position, version: newVersion };
  });
}

// Called within the transaction that changes a member's language area (changeHomeArea in profiles.server.ts). The caller holds the profile row lock.
// Rewrite the area of all this member's stances to the new area (no stance_changes entry, version change, or updated_at change: changing language area is not a stance change). Return the number of rewritten rows.
export async function rewriteStanceAreas(tx: Db, userId: string, area: Area): Promise<number> {
  const rows = await tx
    .update(stances)
    .set({ area })
    .where(and(eq(stances.userId, userId), sql`${stances.area} <> ${area}`))
    .returning({ questionId: stances.questionId });
  return rows.length;
}

// Member-initiated deletion (the right to deletion takes precedence over append-only records). Delete the stance and change records for a question, including when the question is deleted or hidden.
// No rate limit. Leave stance_locked_at intact. Lock the profile row first to serialize with other stance changes.
export async function deleteStanceRecord(db: Db, userId: string, questionId: number): Promise<{ stances: number; changes: number }> {
  return db.transaction(async (tx) => {
    await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    const removedStances = await tx.delete(stances).where(and(eq(stances.userId, userId), eq(stances.questionId, questionId))).returning({ questionId: stances.questionId });
    const removedChanges = await tx.delete(stanceChanges).where(and(eq(stanceChanges.userId, userId), eq(stanceChanges.questionId, questionId))).returning({ id: stanceChanges.id });
    return { stances: removedStances.length, changes: removedChanges.length };
  });
}

// Delete all records on account withdrawal (withdrawal is not implemented yet; provide the callable function only. ON DELETE CASCADE also removes these rows).
export async function deleteAllStanceRecords(db: Db, userId: string): Promise<{ stances: number; changes: number }> {
  return db.transaction(async (tx) => {
    await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    const removedStances = await tx.delete(stances).where(eq(stances.userId, userId)).returning({ questionId: stances.questionId });
    const removedChanges = await tx.delete(stanceChanges).where(eq(stanceChanges.userId, userId)).returning({ id: stanceChanges.id });
    return { stances: removedStances.length, changes: removedChanges.length };
  });
}

// ---- /settings/stances (the member's own records) ----

export type OwnStanceRecord = {
  questionId: number;
  // Do not show titles of unreadable questions (deleted questions or hidden questions the viewer may not see).
  question: { state: "visible" | "hidden" | "deleted"; title: TitleDisplay | null };
  // Current stance (null if withdrawn).
  position: Position | null;
  updatedAt: Date | null;
  // Chronological order, oldest first. Triggers have an href only for readable posts (otherwise null, shown only as 「読めない投稿」).
  changes: Array<{ from: Position | null; to: Position | null; at: Date; trigger: { entryId: number; href: string | null } | null }>;
};

// List questions with at least one stance or change record, newest change first. Read only the member's own rows.
export async function listOwnStanceRecords(
  db: Db,
  userId: string,
  opts: { readLangs: readonly Lang[]; displayLang: Lang; viewer: Viewer },
): Promise<OwnStanceRecord[]> {
  // Title display and reply locations rely on the display layer (rendering and translations), so import it here: profiles.server.ts imports this module because changeHomeArea calls rewriteStanceAreas.
  // Avoid importing the display layer at module scope to keep profile operations lightweight.
  const [{ loadTitleDisplays }, { replyLocation }] = await Promise.all([import("~/lib/entry-display.server"), import("~/lib/entries.server")]);
  const [stanceRows, changeRows] = await Promise.all([
    db.select({ questionId: stances.questionId, position: stances.position, updatedAt: stances.updatedAt }).from(stances).where(eq(stances.userId, userId)),
    db
      .select({
        id: stanceChanges.id,
        questionId: stanceChanges.questionId,
        fromPosition: stanceChanges.fromPosition,
        toPosition: stanceChanges.toPosition,
        triggerEntryId: stanceChanges.triggerEntryId,
        createdAt: stanceChanges.createdAt,
      })
      .from(stanceChanges)
      .where(eq(stanceChanges.userId, userId))
      .orderBy(asc(stanceChanges.createdAt), asc(stanceChanges.id)),
  ]);
  const questionIds = [...new Set([...stanceRows.map((r) => r.questionId), ...changeRows.map((r) => r.questionId)])];
  if (questionIds.length === 0) return [];
  const triggerIds = [...new Set(changeRows.map((r) => r.triggerEntryId).filter((v): v is number => v !== null))];
  const lookup = [...new Set([...questionIds, ...triggerIds])];
  const entryRows = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      threadId: entries.threadId,
      lang: entries.lang,
      title: entries.title,
      sourceHash: entries.sourceHash,
      authorId: entries.authorId,
      hiddenAt: entries.hiddenAt,
      deletedAt: entries.deletedAt,
    })
    .from(entries)
    .where(inArray(entries.id, lookup));
  const byId = new Map(entryRows.map((e) => [e.id, e]));
  const readable = (e: { authorId: string; lang: string; hiddenAt: Date | null; deletedAt: Date | null } | undefined) =>
    e !== undefined && e.deletedAt === null && (e.hiddenAt === null || canSeeHidden(opts.viewer, e));
  const shownQuestions = questionIds.map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined && readable(e));
  const titles = await loadTitleDisplays(
    db,
    shownQuestions.map((e) => ({ id: e.id, lang: e.lang as Lang, title: e.title, sourceHash: e.sourceHash })),
    { readLangs: opts.readLangs, displayLang: opts.displayLang },
    true,
  );
  // Whether the trigger post is readable: both the post and its topic must be undeleted, and any hidden entry must be visible to this viewer.
  const hrefOf = async (entryId: number): Promise<string | null> => {
    const e = byId.get(entryId);
    if (!e || !readable(e)) return null;
    const threadId = e.threadId ?? e.id;
    const thread = byId.get(threadId) ?? (await db.select({ id: entries.id, authorId: entries.authorId, lang: entries.lang, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt }).from(entries).where(eq(entries.id, threadId)))[0];
    if (!readable(thread)) return null;
    return e.kind === "topic" ? `/t/${e.id}#p-${e.id}` : replyLocation(db, threadId, e.id);
  };
  const hrefs = new Map<number, string | null>();
  for (const id of triggerIds) hrefs.set(id, await hrefOf(id));

  const positionOf = new Map(stanceRows.map((r) => [r.questionId, r]));
  const records = questionIds.map((questionId): OwnStanceRecord & { last: number } => {
    const e = byId.get(questionId);
    const state: OwnStanceRecord["question"]["state"] = !e || e.deletedAt !== null ? "deleted" : e.hiddenAt !== null ? "hidden" : "visible";
    const changes = changeRows
      .filter((c) => c.questionId === questionId)
      .map((c) => ({
        from: c.fromPosition as Position | null,
        to: c.toPosition as Position | null,
        at: c.createdAt,
        trigger: c.triggerEntryId === null ? null : { entryId: c.triggerEntryId, href: hrefs.get(c.triggerEntryId) ?? null },
      }));
    const current = positionOf.get(questionId);
    const lastChange = changes.at(-1)?.at ?? current?.updatedAt ?? new Date(0);
    return {
      questionId,
      question: { state, title: e && readable(e) ? (titles.get(questionId) ?? null) : null },
      position: (current?.position as Position | undefined) ?? null,
      updatedAt: current?.updatedAt ?? null,
      changes,
      last: lastChange.getTime(),
    };
  });
  records.sort((a, b) => b.last - a.last || b.questionId - a.questionId);
  return records.map(({ last: _last, ...record }) => record);
}
