import { publicTopicPlace } from "~/lib/visibility.server";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { readDistributions, type DistributionViewer } from "~/lib/distribution.server";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { isoSeconds, threadCanonical, twinPreamble } from "~/lib/md/urls.server";

// Question-distribution twin (/t/:id/stances.md/.txt): stance totals and total_langs only, never per-language counts.
// Always return current counts, even before choosing a stance: fetching equals the explicit 「先に結果を見る」 action. Thread twin /t/:id.md excludes distribution.
// Exclude the reader's stance, since 「AIで開く」 sends the file to an external AI provider. Not in changes/manifest; fetch when needed.
// Non-question/deleted question returns null/404. Hidden question returns only hidden:true, no counts. Read exclusively via readDistributions, which excludes deleted/hidden choices.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function buildStancesMarkdown(db: Db, questionId: number, viewer: DistributionViewer, opts: { now?: Date } = {}): Promise<string | null> {
  const [question] = await db
    .select({ id: entries.id, title: entries.title, lang: entries.lang, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(and(eq(entries.id, questionId), eq(entries.kind, "topic"), eq(entries.asksStance, true), isNull(entries.deletedAt), publicTopicPlace()));
  if (!question) return null;
  const preamble = { preamble: twinPreamble() };
  const id = `p-${question.id}`;
  if (question.hiddenAt !== null) {
    return mdBlock({ type: "stances", question: id, hidden: true, content_trust: "untrusted_user_content" }, null, preamble);
  }
  const now = opts.now ?? new Date();
  const distribution = (await readDistributions(db, [questionId], viewer, { now })).get(questionId);
  if (!distribution) return null;
  const body =
    distribution.total === 0
      ? "No member has chosen a stance yet. This is the number of members who chose a stance, not the conclusion of the forum."
      : `${plural(distribution.total, "member", "members")} from ${plural(distribution.langs, "language", "languages")} chose a stance. This is the number of members who chose a stance, not the conclusion of the forum.`;
  return mdBlock(
    {
      type: "stances",
      question: id,
      // A question always has its title; a missing title key would mean "no title" (the rule of all the twins).
      title: question.title ?? undefined,
      lang: question.lang,
      canonical: threadCanonical(question.id),
      as_of: isoSeconds(distribution.asOf),
      total: distribution.total,
      counts: { agree: distribution.counts.agree, disagree: distribution.counts.disagree, neither: distribution.counts.neither },
      total_langs: distribution.langs,
      content_trust: "untrusted_user_content",
    },
    body,
    preamble,
  );
}
