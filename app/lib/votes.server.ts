import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, votes } from "~/lib/db/schema";

// "Insightful" (formerly the vote): the reader gained a new perspective from a post. It is not agreement.
// - It is a +1 on a topic or a reply that can be added and removed. Nobody can press it on their own post.
// - It is stored with the voter's home area at that moment (votes.voter_area) and counted per (post x area) internally for operator observation.
//   Members only ever see the total and the number of languages it came from, never a count per language. The total can order topic lists when the reader chooses Insightful ordering. The daily reasons use only whether at least one counted
//   Insightful exists, after choosing the language; the number of presses does not affect the draw.
// - Members under the operator action exclude_reactions (profiles.reactions_excluded_at) are not counted, neither in the total nor in the number of languages.
// The names (votes, setVote, /vote) are kept from before the meaning changed.

export type VoteError = "not_found" | "own_entry" | "no_profile";

class VisibilityBusy extends Error {
  constructor(readonly entryId: number, cause: unknown) { super("Visibility update in progress", { cause }); }
}
async function visibilityRead<T>(entryId: number, read: () => PromiseLike<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "55P03") throw new VisibilityBusy(entryId, error);
    throw error;
  }
}

// Writers may lock related topics before a reply, or just the reply before its
// topic. Never wait for one visibility lock while holding the other. A rolled
// back wait savepoint releases its lock even if the caller owns a transaction.
async function waitForVisibilityWriter(db: Db, entryId: number): Promise<void> {
  const ready = new Error("visibility writer finished");
  try {
    await db.transaction(async tx => {
      await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, entryId)).for("no key update");
      throw ready;
    });
  } catch (error) { if (error !== ready) throw error; }
}

// Add a vote (on = true) or remove it (false). New votes use the current language area as voter_area. Leave existing votes unchanged, including their stored area.
// Removing a nonexistent vote is a no-op. changed indicates whether a vote row was added or removed.
export async function setVote(
  db: Db,
  voterId: string,
  entryId: number,
  on: boolean,
  opts: { now?: Date } = {},
): Promise<{ ok: true; voted: boolean; changed: boolean } | { ok: false; error: VoteError }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [history] = await tx.select({ started: entries.historyStartedAt }).from(entries).where(eq(entries.id, entryId));
        const [entry] = await visibilityRead(entryId, () => tx
          .select({ authorId: entries.authorId, threadId: entries.threadId, hiddenAt: entries.hiddenAt, historyStartedAt: entries.historyStartedAt })
          .from(entries)
          .where(and(eq(entries.id, entryId), isNull(entries.deletedAt)))
          // Only the first reaction writes the history latch. Later voters
          // share the visibility lock without serializing with one another.
          .for(history?.started ? "share" : "no key update", { noWait: true }));
        if (!entry) return { ok: false as const, error: "not_found" as const };
        // Hidden posts cannot receive new votes, though existing votes may be removed.
        if (on && entry.hiddenAt) return { ok: false as const, error: "not_found" as const };
        // Replies to deleted topics are unreadable and cannot receive votes.
        if (entry.threadId !== null) {
          const [topic] = await visibilityRead(entry.threadId, () => tx.select({ id: entries.id, hiddenAt: entries.hiddenAt }).from(entries).where(and(eq(entries.id, entry.threadId!), isNull(entries.deletedAt))).for("share", { noWait: true }));
          if (!topic || (on && topic.hiddenAt)) return { ok: false as const, error: "not_found" as const };
        }
        if (entry.authorId === voterId) return { ok: false as const, error: "own_entry" as const };
        if (!on) {
          const removed = await tx
            .delete(votes)
            .where(and(eq(votes.entryId, entryId), eq(votes.voterId, voterId)))
            .returning({ entryId: votes.entryId, createdAt: votes.createdAt });
          // Preserve reactions that predate the history latch, too. Their
          // timestamps would otherwise disappear when the old row is removed.
          if (removed.length && !entry.historyStartedAt) await tx.update(entries)
            .set({ historyStartedAt: removed[0].createdAt })
            .where(and(eq(entries.id, entryId), isNull(entries.historyStartedAt)));
          return { ok: true as const, voted: false, changed: removed.length > 0 };
        }
        const [profile] = await tx.select({ homeArea: profiles.homeArea }).from(profiles).where(eq(profiles.userId, voterId));
        if (!profile) return { ok: false as const, error: "no_profile" as const };
        const added = await tx
          .insert(votes)
          .values({ entryId, voterId, voterArea: profile.homeArea, createdAt: opts.now ?? new Date() })
          .onConflictDoNothing()
          .returning({ entryId: votes.entryId });
        if (added.length && !entry.historyStartedAt) await tx.update(entries)
          .set({ historyStartedAt: opts.now ?? new Date() })
          .where(and(eq(entries.id, entryId), isNull(entries.historyStartedAt)));
        return { ok: true as const, voted: true, changed: added.length > 0 };
      });
    } catch (error) {
      if (!(error instanceof VisibilityBusy) || attempt >= 4) throw error;
      await waitForVisibilityWriter(db, error.entryId);
    }
  }
}

// The Insightful count a member is shown: the total and the number of languages (home areas of the members who pressed it; "other" counts as one). Nothing per language.
export type InsightfulCount = { total: number; langs: number };
export type Reactions = {
  insightful: InsightfulCount;
  // Whether the viewer pressed it (read from the viewer's own row, exclusion or not).
  mine: boolean;
};
// Only the id is read; kind and authorId are accepted so that callers that already have them (lists, threads) can pass their rows as they are.
export type ReactionTarget = { id: number; kind?: "topic" | "reply"; authorId?: string };

export const NO_REACTIONS: Reactions = { insightful: { total: 0, langs: 0 }, mine: false };

// The Insightful count and the viewer's own state for many posts at once (one page of a list or a thread; the number of queries does not depend on the number of posts).
// The query groups by voter_area, and the result is folded here into the total and the number of non-empty areas: nothing per area leaves this function, so no loader,
// response or Markdown twin can carry it. Excluded members' rows are left out of the count (an inner join on profiles) but not out of `mine`.
export async function loadReactions(db: Db, targets: readonly ReactionTarget[], viewerId: string | null): Promise<Map<number, Reactions>> {
  const out = new Map<number, Reactions>();
  if (targets.length === 0) return out;
  const ids = targets.map((t) => t.id);
  const [voteRows, mineRows] = await Promise.all([
    db
      .select({ entryId: votes.entryId, area: votes.voterArea, n: sql<number>`count(*)::int` })
      .from(votes)
      .innerJoin(profiles, and(eq(profiles.userId, votes.voterId), isNull(profiles.reactionsExcludedAt)))
      .where(inArray(votes.entryId, ids))
      .groupBy(votes.entryId, votes.voterArea),
    viewerId === null
      ? Promise.resolve([] as Array<{ entryId: number }>)
      : db.select({ entryId: votes.entryId }).from(votes).where(and(eq(votes.voterId, viewerId), inArray(votes.entryId, ids))),
  ]);
  const total = new Map<number, number>();
  const langs = new Map<number, number>();
  for (const r of voteRows) {
    total.set(r.entryId, (total.get(r.entryId) ?? 0) + Number(r.n));
    langs.set(r.entryId, (langs.get(r.entryId) ?? 0) + 1);
  }
  const mine = new Set(mineRows.map((r) => r.entryId));
  for (const t of targets) out.set(t.id, { insightful: { total: total.get(t.id) ?? 0, langs: langs.get(t.id) ?? 0 }, mine: mine.has(t.id) });
  return out;
}
