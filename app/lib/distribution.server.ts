import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, stances } from "~/lib/db/schema";
import { AREAS, type Area } from "~/lib/languages";
import type { Profile } from "~/lib/profiles.server";
import type { Position } from "~/lib/stances";

// Sole reader of stance distributions. Screens, Markdown, and /stance responses all read through readDistributions here.
// Only this file may count `stances`, excluding own-row reads in stances.server.ts and member exports. tests/distribution.test.ts verifies this by scanning source.
//
// Expose only the three stance totals, participant count, and number of represented languages (Distribution). Do not provide per-language counts, language names, or 「言語の別に見る」.
// Internally, continue counting by language area for the language count, future ordering, and operator observations. Expose that breakdown (AreaDistribution) only through the operator-facing
// readAreaDistributions. Member paths (screens, Markdown, /stance, /vote, exports) must not call it. A separate function rather than an argument flag lets types
// reveal when per-area counts reach a member-facing path.
// Count suspended members' stances, but exclude members affected by exclude_reactions. This function itself removes deleted/hidden questions and non-question topics
// from the returned Map; callers treat absent ids as having no distribution. Do not vary output by participant/language count: return the same shape even for one person or one language.

// Viewer contexts for member and observation reads.
export type DistributionViewer = { kind: "member"; userId: string } | { kind: "observation" };

// Sole place determining the viewer. Regard every active member with a profile, including suspended members, as approved.
export function distributionViewerFor(member: { userId: string; profile: Profile }): DistributionViewer {
  return { kind: "member", userId: member.userId };
}

// Display shape, used by screens, Markdown, /stance responses, member exports, and observation exports. Contains neither per-area counts nor language names.
export type Distribution = {
  questionId: number;
  // Number of members who selected a stance.
  total: number;
  // Totals for the three stances across language areas.
  counts: Record<Position, number>;
  // Number of language areas represented by participants. Count 「その他」 as one; zero when total is zero.
  langs: number;
  asOf: Date;
};

// Internal shape with per-area counts. Only operator-facing readAreaDistributions may return it outside this file.
export type AreaPositionCounts = { area: Area; agree: number; disagree: number; neither: number };
// In AREAS order; omit areas with zero participants.
export type AreaDistribution = Distribution & { byArea: AreaPositionCounts[] };

// Build the internal shape from aggregate rows (area × stance × count); pure function.
export function summarizeDistribution(
  questionId: number,
  rows: ReadonlyArray<{ area: Area; position: Position; count: number }>,
  asOf: Date,
): AreaDistribution {
  const counts: Record<Position, number> = { agree: 0, disagree: 0, neither: 0 };
  const perArea = new Map<Area, AreaPositionCounts>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    counts[r.position] += r.count;
    let row = perArea.get(r.area);
    if (!row) perArea.set(r.area, (row = { area: r.area, agree: 0, disagree: 0, neither: 0 }));
    row[r.position] += r.count;
  }
  const byArea = AREAS.flatMap((area) => {
    const row = perArea.get(area);
    return row ? [row] : [];
  });
  return { questionId, total: counts.agree + counts.disagree + counts.neither, counts, langs: byArea.length, asOf, byArea };
}

// Convert internal to display shape by creating a fresh object with only five fields. Do not retain byArea through spreading or recasting.
export function toDistribution(d: AreaDistribution): Distribution {
  return {
    questionId: d.questionId,
    total: d.total,
    counts: { agree: d.counts.agree, disagree: d.counts.disagree, neither: d.counts.neither },
    langs: d.langs,
    asOf: d.asOf,
  };
}

// The sole counting query, called by both readDistributions and readAreaDistributions.
// 1. Select eligible questions, excluding deleted/hidden questions and non-question topics here. Omit excluded ids from the returned Map.
// 2. Count stances only for those ids. Omit excluded members but count suspended members. Group by area for the language count and operator reads.
async function loadAreaDistributions(db: Db, questionIds: readonly number[], now: Date): Promise<Map<number, AreaDistribution>> {
  const out = new Map<number, AreaDistribution>();
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return out;
  const questions = await db
    .select({ id: entries.id })
    .from(entries)
    .where(and(inArray(entries.id, ids), eq(entries.kind, "topic"), eq(entries.asksStance, true), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
  const live = questions.map((q) => q.id);
  if (live.length === 0) return out;
  const rows = await db
    .select({ questionId: stances.questionId, area: stances.area, position: stances.position, n: sql<number>`count(*)::int` })
    .from(stances)
    .innerJoin(profiles, eq(profiles.userId, stances.userId))
    .where(and(inArray(stances.questionId, live), isNull(profiles.reactionsExcludedAt)))
    .groupBy(stances.questionId, stances.area, stances.position);
  const byQuestion = new Map<number, Array<{ area: Area; position: Position; count: number }>>();
  for (const r of rows) {
    const list = byQuestion.get(r.questionId) ?? [];
    list.push({ area: r.area as Area, position: r.position as Position, count: Number(r.n) });
    byQuestion.set(r.questionId, list);
  }
  for (const id of live) out.set(id, summarizeDistribution(id, byQuestion.get(id) ?? [], now));
  return out;
}

// All screens, Markdown, /stance responses, and exports pass through here. Return the display shape (totals and language count) for every viewer.
// This function never returns the viewer's own stance.
export async function readDistributions(db: Db, questionIds: readonly number[], viewer: DistributionViewer, opts: { now?: Date } = {}): Promise<Map<number, Distribution>> {
  void viewer;
  const detailed = await loadAreaDistributions(db, questionIds, opts.now ?? new Date());
  return new Map([...detailed].map(([id, d]) => [id, toDistribution(d)]));
}

// Operator-facing, with per-area counts. Accept only observation viewers through the type. Only operator-exclusive code may call it: app/routes/admin-*.ts(x) and
// app/lib/observation.server.ts called exclusively from those routes. Member screens, Markdown, /stance, /vote, and exports must not call it; tests/distribution.test.ts scans source to verify.
export async function readAreaDistributions(
  db: Db,
  questionIds: readonly number[],
  viewer: Extract<DistributionViewer, { kind: "observation" }>,
  opts: { now?: Date } = {},
): Promise<Map<number, AreaDistribution>> {
  void viewer;
  return loadAreaDistributions(db, questionIds, opts.now ?? new Date());
}
