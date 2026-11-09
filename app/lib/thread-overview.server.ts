import { and, count, countDistinct, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { STANCE_TAGS } from "~/lib/stances";

// A rule-based count of the replies of a thread that a reader can read now: not deleted, not hidden by moderation.
// It is the same for every reader with the same access and at the same moment: it does not depend on the reader's
// languages, display language or the author's language area. Deleted and hidden replies are not counted and nothing
// about them (how many, their languages, their marks) is derived from here. The languages are a number only (how many
// original languages the readable replies are written in), never a count per language, like insightful_langs.

export type ThreadOverviewCounts = {
  // Readable replies. The topic post itself is not included.
  replies: number;
  // In how many original languages the readable replies are written.
  langs: number;
  // Readable replies per stance mark, with "untagged" for replies that carry none. Only read for a question.
  stanceTags: Record<(typeof STANCE_TAGS)[number] | "untagged", number> | null;
};

const readableReplies = (threadId: number) =>
  and(eq(entries.threadId, threadId), eq(entries.kind, "reply"), isNull(entries.deletedAt), isNull(entries.hiddenAt));

export async function loadThreadOverviewCounts(db: Db, threadId: number, opts: { question: boolean }): Promise<ThreadOverviewCounts> {
  const [[totals], tagRows] = await Promise.all([
    db.select({ replies: count(), langs: countDistinct(entries.lang) }).from(entries).where(readableReplies(threadId)),
    opts.question
      ? db.select({ stanceTag: entries.stanceTag, n: count() }).from(entries).where(readableReplies(threadId)).groupBy(entries.stanceTag)
      : Promise.resolve(null),
  ]);
  let stanceTags: ThreadOverviewCounts["stanceTags"] = null;
  if (tagRows) {
    stanceTags = { agree: 0, disagree: 0, neither: 0, objection: 0, untagged: 0 };
    for (const row of tagRows) {
      const tag = (STANCE_TAGS as readonly string[]).includes(row.stanceTag ?? "") ? (row.stanceTag as (typeof STANCE_TAGS)[number]) : "untagged";
      stanceTags[tag] += Number(row.n);
    }
  }
  return { replies: Number(totals.replies), langs: Number(totals.langs), stanceTags };
}

// How many original languages the readable replies are written in (the heading of the replies shows it from two on): one aggregate, no rows.
export async function countReplyLanguages(db: Db, threadId: number): Promise<number> {
  const [row] = await db.select({ langs: countDistinct(entries.lang) }).from(entries).where(readableReplies(threadId));
  return Number(row.langs);
}
