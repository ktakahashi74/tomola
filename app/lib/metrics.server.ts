import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { AI_ASSISTANCE, type AiAssistance } from "~/lib/ai-assistance";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, stanceChanges, translationReports, votes } from "~/lib/db/schema";
import { AREAS, LANGS, type Area, type Lang } from "~/lib/languages";
import { POSITIONS, type Position } from "~/lib/stances";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";

// Operator metrics (/admin/metrics): observations computed from stored data.
// Count language areas at posting time (entries.author_area). Later membership-area changes do not alter past counts.
// Posts without author profiles (null author_area) do not contribute to per-area counts.
// Exclude deleted/moderation-hidden posts from every metric, including replies to deleted/hidden topics (app/lib/visibility.server.ts).

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type WeeklyCrossAreaRate = {
  // UTC Monday midnight; week is [weekStart,weekStart+7 days). Last week is the current unfinished week.
  weekStart: Date;
  // Topics receiving replies during the week.
  topics: number;
  // Of those, topics with replies that week from members of at least two language areas.
  crossArea: number;
  // crossArea / topics. Null when there are no topics (「未観測」).
  rate: number | null;
  // Number of members who replied to topics in the denominator during that week.
  people: number;
};

// Start of the UTC Monday-based week containing the timestamp.
export function weekStartOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
}

// Cross-area reply rate by recent calendar week (default 8; oldest first, ending with current week): fraction of topics replied to by at least two areas.
// UTC Monday-midnight boundaries do not move with page-opening time; current week is partial. Denominator: undeleted topics receiving undeleted replies
// during the week. Numerator: those with repliers from at least two areas, irrespective of the topic author's area.
export async function crossAreaReplyRate(db: Db, now: Date, weeks = 8): Promise<WeeklyCrossAreaRate[]> {
  const first = new Date(weekStartOf(now).getTime() - (weeks - 1) * WEEK_MS);
  const topic = alias(entries, "topic");
  // Week index from the oldest start: 0 oldest, weeks-1 current.
  const week = sql<number>`floor(extract(epoch from (${entries.createdAt} - ${first.toISOString()}::timestamptz)) / ${WEEK_MS / 1000})::int`;
  const rows = await db
    .selectDistinct({ week, threadId: entries.threadId, area: entries.authorArea, authorId: entries.authorId })
    .from(entries)
    .innerJoin(topic, and(eq(topic.id, entries.threadId), eq(topic.kind, "topic"), isNull(topic.deletedAt), isNull(topic.hiddenAt)))
    .where(
      and(
        eq(entries.kind, "reply"),
        isNull(entries.deletedAt),
        isNull(entries.hiddenAt),
        isNotNull(entries.authorArea),
        gte(entries.createdAt, first),
        lte(entries.createdAt, now),
      ),
    );
  const byWeek = new Map<number, Map<number, Set<string>>>();
  const peopleByWeek = new Map<number, Set<string>>();
  for (const r of rows) {
    if (r.threadId === null) continue;
    const w = Number(r.week);
    if (r.area === null) continue;
    const threads = byWeek.get(w) ?? new Map<number, Set<string>>();
    const areas = threads.get(r.threadId) ?? new Set<string>();
    areas.add(r.area);
    threads.set(r.threadId, areas);
    byWeek.set(w, threads);
    const people = peopleByWeek.get(w) ?? new Set<string>();
    people.add(r.authorId);
    peopleByWeek.set(w, people);
  }
  return Array.from({ length: weeks }, (_, w) => {
    const threads = [...(byWeek.get(w)?.values() ?? [])];
    const crossArea = threads.filter((areas) => areas.size >= 2).length;
    return {
      weekStart: new Date(first.getTime() + w * WEEK_MS),
      topics: threads.length,
      crossArea,
      rate: threads.length > 0 ? crossArea / threads.length : null,
      people: peopleByWeek.get(w)?.size ?? 0,
    };
  });
}

export type AreaCount = { area: Area; count: number };

// Active writers by area over the last 30 days: members with at least two topics/replies, excluding deleted/hidden posts. Return every area in AREAS order.
// Count each member once in the author_area of their latest post in the window, even if they changed area during that window.
export async function sustainedWritersByArea(db: Db, now: Date, opts: { days?: number; minPosts?: number } = {}): Promise<AreaCount[]> {
  const since = new Date(now.getTime() - (opts.days ?? 30) * DAY_MS);
  const writers = db
    .select({
      authorId: entries.authorId,
      area: sql<string | null>`(array_agg(${entries.authorArea} order by ${entries.createdAt} desc, ${entries.id} desc))[1]`.as("area"),
    })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(visibleWithTopic(), gte(entries.createdAt, since), lte(entries.createdAt, now)))
    .groupBy(entries.authorId)
    .having(sql`count(*) >= ${opts.minPosts ?? 2}`)
    .as("writers");
  const rows = await db
    .select({ area: writers.area, n: sql<number>`count(*)::int` })
    .from(writers)
    .where(isNotNull(writers.area))
    .groupBy(writers.area);
  const counts = new Map(rows.map((r) => [r.area, Number(r.n)]));
  return AREAS.map((area) => ({ area, count: counts.get(area) ?? 0 }));
}

export type ReportStats = {
  total: number;
  open: number;
  resolved: number;
  // Resolved without human action (automatic retranslation, edited source, deleted post; resolved_by=null), a subset of resolved.
  autoResolved: number;
  // Median seconds to human resolution (translation correction or closure), null without human resolutions. Exclude automatic closure, whose few-second delays obscure human response speed.
  medianResolutionSeconds: number | null;
};

// Mistranslation-report counts and median time from report to human resolved_at.
export async function reportStats(db: Db, period?: { from: Date; to: Date }): Promise<ReportStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`(count(*) filter (where ${translationReports.status} = 'open'))::int`,
      resolved: sql<number>`(count(*) filter (where ${translationReports.status} = 'resolved'))::int`,
      auto: sql<number>`(count(*) filter (where ${translationReports.status} = 'resolved' and ${translationReports.resolvedBy} is null))::int`,
      median: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${translationReports.resolvedAt} - ${translationReports.createdAt}))) filter (where ${translationReports.status} = 'resolved' and ${translationReports.resolvedAt} is not null and ${translationReports.resolvedBy} is not null)`,
    })
    .from(translationReports)
    .where(period ? and(gte(translationReports.createdAt, period.from), lt(translationReports.createdAt, period.to)) : undefined);
  return {
    total: Number(row.total),
    open: Number(row.open),
    resolved: Number(row.resolved),
    autoResolved: Number(row.auto),
    medianResolutionSeconds: row.median === null ? null : Number(row.median),
  };
}

// counts and total cover only the posts that state a value; unstated is the number of posts without one (posts written on screen state none).
export type AiAssistanceRow = { area: Area; counts: Record<AiAssistance, number>; total: number; unstated: number };

// ai_assistance distribution per posting-time author_area for topics/replies, excluding deleted/hidden posts.
// Only stated values contribute to total's denominator. Count null separately as unstated. Return all areas in AREAS order.
export async function aiAssistanceByArea(db: Db): Promise<AiAssistanceRow[]> {
  const rows = await db
    .select({ area: entries.authorArea, level: entries.aiAssistance, n: sql<number>`count(*)::int` })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(visibleWithTopic(), isNotNull(entries.authorArea), inArray(entries.kind, ["topic", "reply"])))
    .groupBy(entries.authorArea, entries.aiAssistance);
  return AREAS.map((area) => {
    const counts = Object.fromEntries(AI_ASSISTANCE.map((l) => [l, 0])) as Record<AiAssistance, number>;
    let unstated = 0;
    for (const r of rows) {
      if (r.area !== area) continue;
      if (r.level === null) unstated += Number(r.n);
      else if ((AI_ASSISTANCE as readonly string[]).includes(r.level)) counts[r.level as AiAssistance] = Number(r.n);
    }
    return { area, counts, total: AI_ASSISTANCE.reduce((sum, l) => sum + counts[l], 0), unstated };
  });
}

// How the readable posts were written: on the screen (web) or through the API (a draft that the member read and published). numerator = the posts that came that way, denominator = all readable
// topics and replies, people = the members who wrote them that way. Over everything so far (like the AI-assistance record above). The API cannot publish: an "api" post is a draft that its author
// confirmed in the browser. "Not observed" (an empty list) when there is no readable post.
export type ViaRow = { via: "web" | "api"; numerator: number; denominator: number; people: number };
export async function postsByVia(db: Db): Promise<ViaRow[]> {
  const rows = await db
    .select({ via: entries.via, n: sql<number>`count(*)::int`, people: sql<number>`count(distinct ${entries.authorId})::int` })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(visibleWithTopic(), inArray(entries.kind, ["topic", "reply"])))
    .groupBy(entries.via);
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  if (total === 0) return [];
  return (["web", "api"] as const).map((via) => {
    const row = rows.find((r) => r.via === via);
    return { via, numerator: Number(row?.n ?? 0), denominator: total, people: Number(row?.people ?? 0) };
  });
}

// ---- Engagement and cross-language metrics ----
// Every rate comes with its numerator, its denominator and the number of people behind it; a week (or a cohort) with a zero denominator is "not observed" (observed: false).
// Common rules: members under exclude_reactions (profiles.reactions_excluded_at) do not count (their stances and Insightful; the exclusion works backwards, so a change of the state moves
// the past weeks too); hidden and deleted posts, and posts in a hidden or deleted topic, do not count (visibleWithTopic); the stance changes of a hidden or deleted question do not count.
// A member who removes their stance record (or an Insightful) takes the rows out of the past weeks too. Weeks are UTC Mondays (weekStartOf); the last week is this week, still running.
// Everything is counted from rows of the period read into memory, like crossAreaReplyRate, which assumes a modest number of rows per period;
// the clock is always the `now` argument.

// The start of a member's time with the forum (the cohort week and the 14 days of "first participation" count from it).
// Use profiles.created_at; keep the membership-start definition in this one place.
export const memberStartAt: SQL = sql`${profiles.createdAt}`;

// A member reaches the first stance or the first post within this many days of the start.
export const FIRST_PARTICIPATION_DAYS = 14;
// The retention week: the week that starts this many weeks after the cohort week.
export const RETENTION_WEEKS = 4;

export type RateCell =
  | { observed: true; numerator: number; denominator: number; people: number; rate: number }
  | { observed: false; numerator: 0; denominator: 0; people: 0 };

const rateCell = (numerator: number, denominator: number, people: number): RateCell =>
  denominator > 0 ? { observed: true, numerator, denominator, people, rate: numerator / denominator } : { observed: false, numerator: 0, denominator: 0, people: 0 };

// The starts of the last `weeks` weeks, oldest first (this week last).
export function observationWeeks(now: Date, weeks = 8): Date[] {
  const first = weekStartOf(now).getTime() - (weeks - 1) * WEEK_MS;
  return Array.from({ length: weeks }, (_, i) => new Date(first + i * WEEK_MS));
}
const weekIndexOf = (at: Date, first: Date) => Math.floor((at.getTime() - first.getTime()) / WEEK_MS);

// 1. Cross-language insight rate (weekly): of the Insightful given that week on a post whose author_area is known, those whose voter_area differs from the author_area ("other" with "other" is not
// cross-language: the two values are equal). People: the members who pressed it in the denominator rows.
export async function crossAreaInsightfulRate(db: Db, now: Date, weeks = 8): Promise<Array<{ weekStart: Date } & RateCell>> {
  const starts = observationWeeks(now, weeks);
  const rows = await db
    .select({ voterId: votes.voterId, voterArea: votes.voterArea, authorArea: entries.authorArea, createdAt: votes.createdAt })
    .from(votes)
    .innerJoin(entries, eq(entries.id, votes.entryId))
    .innerJoin(rootTopic, rootTopicOn())
    .innerJoin(profiles, and(eq(profiles.userId, votes.voterId), isNull(profiles.reactionsExcludedAt)))
    .where(and(visibleWithTopic(), isNotNull(entries.authorArea), gte(votes.createdAt, starts[0]), lte(votes.createdAt, now)));
  const perWeek = starts.map(() => ({ numerator: 0, denominator: 0, people: new Set<string>() }));
  for (const r of rows) {
    const w = perWeek[weekIndexOf(r.createdAt, starts[0])];
    if (!w) continue;
    w.denominator += 1;
    w.people.add(r.voterId);
    if (r.voterArea !== r.authorArea) w.numerator += 1;
  }
  return starts.map((weekStart, i) => ({ weekStart, ...rateCell(perWeek[i].numerator, perWeek[i].denominator, perWeek[i].people.size) }));
}

// 2. Cross-language update rate (weekly): `changes` is the stance changes of the week that changed a stance (from and to are both set: the first registration and a withdrawal are not changes).
// Denominator: those with a trigger post (trigger_entry_id) whose trigger_area is known; numerator: those whose trigger_area differs from area (both are copies made when the change was
// recorded, so a later change of the home area does not move a past week). People: the members in the denominator rows. A trigger post that was deleted later has lost its link (set null):
// such a change leaves the denominator.
export async function crossAreaUpdateRate(db: Db, now: Date, weeks = 8): Promise<Array<{ weekStart: Date; changes: number } & RateCell>> {
  const starts = observationWeeks(now, weeks);
  const rows = await db
    .select({ userId: stanceChanges.userId, area: stanceChanges.area, triggerEntryId: stanceChanges.triggerEntryId, triggerArea: stanceChanges.triggerArea, createdAt: stanceChanges.createdAt })
    .from(stanceChanges)
    .innerJoin(rootTopic, and(eq(rootTopic.id, stanceChanges.questionId), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt)))
    .innerJoin(profiles, and(eq(profiles.userId, stanceChanges.userId), isNull(profiles.reactionsExcludedAt)))
    .where(and(isNotNull(stanceChanges.fromPosition), isNotNull(stanceChanges.toPosition), gte(stanceChanges.createdAt, starts[0]), lte(stanceChanges.createdAt, now)));
  const perWeek = starts.map(() => ({ changes: 0, numerator: 0, denominator: 0, people: new Set<string>() }));
  for (const r of rows) {
    const w = perWeek[weekIndexOf(r.createdAt, starts[0])];
    if (!w) continue;
    w.changes += 1;
    if (r.triggerEntryId === null || r.triggerArea === null) continue;
    w.denominator += 1;
    w.people.add(r.userId);
    if (r.triggerArea !== r.area) w.numerator += 1;
  }
  return starts.map((weekStart, i) => ({ weekStart, changes: perWeek[i].changes, ...rateCell(perWeek[i].numerator, perWeek[i].denominator, perWeek[i].people.size) }));
}

// What makes a member "active": creating a topic or a reply (visible ones), pressing Insightful on a visible post (not under exclusion), recording a stance change (any row: a first
// registration, a change or a withdrawal; not under exclusion; on a visible question). One element per event, read for [from, to].
type ActivityEvent = { userId: string; at: Date };
async function activityEvents(db: Db, from: Date, to: Date): Promise<ActivityEvent[]> {
  const [posts, reactions, stanceRows] = await Promise.all([
    db
      .select({ userId: entries.authorId, at: entries.createdAt })
      .from(entries)
      .innerJoin(rootTopic, rootTopicOn())
      .where(and(visibleWithTopic(), inArray(entries.kind, ["topic", "reply"]), gte(entries.createdAt, from), lte(entries.createdAt, to))),
    db
      .select({ userId: votes.voterId, at: votes.createdAt })
      .from(votes)
      .innerJoin(entries, eq(entries.id, votes.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .innerJoin(profiles, and(eq(profiles.userId, votes.voterId), isNull(profiles.reactionsExcludedAt)))
      .where(and(visibleWithTopic(), gte(votes.createdAt, from), lte(votes.createdAt, to))),
    db
      .select({ userId: stanceChanges.userId, at: stanceChanges.createdAt })
      .from(stanceChanges)
      .innerJoin(rootTopic, and(eq(rootTopic.id, stanceChanges.questionId), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt)))
      .innerJoin(profiles, and(eq(profiles.userId, stanceChanges.userId), isNull(profiles.reactionsExcludedAt)))
      .where(and(gte(stanceChanges.createdAt, from), lte(stanceChanges.createdAt, to))),
  ]);
  return [...posts, ...reactions, ...stanceRows];
}

// 3. Weekly active members: the members with at least one activity event that week (each member once per week).
export async function weeklyActiveMembers(db: Db, now: Date, weeks = 8): Promise<Array<{ weekStart: Date; members: number }>> {
  const starts = observationWeeks(now, weeks);
  const events = await activityEvents(db, starts[0], now);
  const perWeek = starts.map(() => new Set<string>());
  for (const e of events) perWeek[weekIndexOf(e.at, starts[0])]?.add(e.userId);
  return starts.map((weekStart, i) => ({ weekStart, members: perWeek[i].size }));
}

// The members of the cohorts: members whose start (memberStartAt) is in [from, to], without those under exclude_reactions.
async function cohortMembers(db: Db, from: Date, to: Date): Promise<Array<{ userId: string; startAt: Date }>> {
  return db
    .select({ userId: profiles.userId, startAt: sql<Date>`${memberStartAt}`.mapWith(profiles.createdAt) })
    .from(profiles)
    .where(and(isNull(profiles.reactionsExcludedAt), gte(memberStartAt, from), lte(memberStartAt, to)));
}

// 4. Retention after 4 weeks (per cohort: the members whose start is in that week). Denominator = the cohort (people = the same); numerator = those active in the week that starts
// 28 days after the cohort week. "Not observed" until that week has ended (cohortWeek + 35 days <= now), and for an empty cohort.
export async function fourWeekRetention(db: Db, now: Date, cohorts = 8): Promise<Array<{ cohortWeek: Date } & RateCell>> {
  const starts = observationWeeks(now, cohorts);
  const members = await cohortMembers(db, starts[0], now);
  const lag = RETENTION_WEEKS * WEEK_MS;
  const events = await activityEvents(db, new Date(starts[0].getTime() + lag), now);
  const activeAt = new Map<string, number[]>();
  for (const e of events) activeAt.set(e.userId, [...(activeAt.get(e.userId) ?? []), e.at.getTime()]);
  return starts.map((cohortWeek) => {
    const cohort = members.filter((m) => weekIndexOf(m.startAt, cohortWeek) === 0);
    const from = cohortWeek.getTime() + lag;
    const to = from + WEEK_MS;
    if (to > now.getTime()) return { cohortWeek, ...rateCell(0, 0, 0) };
    const retained = cohort.filter((m) => (activeAt.get(m.userId) ?? []).some((t) => t >= from && t < to)).length;
    return { cohortWeek, ...rateCell(retained, cohort.length, cohort.length) };
  });
}

// 5. Reaching a first participation within 14 days of the start (per cohort). Denominator = the cohort; numerators, counted apart: the members whose first stance (the oldest row of their
// stance changes, on a visible question) and the members whose first post (topic or reply, visible) is within 14 days of the start (the 14th day included). "Not observed" until every member of
// the cohort has had the 14 days (cohortWeek + 21 days <= now) and for an empty cohort.
export async function firstParticipation(db: Db, now: Date, cohorts = 8): Promise<Array<{ cohortWeek: Date; stance: RateCell; post: RateCell }>> {
  const starts = observationWeeks(now, cohorts);
  const members = await cohortMembers(db, starts[0], now);
  const ids = members.map((m) => m.userId);
  const [stanceRows, postRows] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({ userId: stanceChanges.userId, at: sql<Date>`min(${stanceChanges.createdAt})`.mapWith(stanceChanges.createdAt) })
            .from(stanceChanges)
            .innerJoin(rootTopic, and(eq(rootTopic.id, stanceChanges.questionId), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt)))
            .where(inArray(stanceChanges.userId, ids))
            .groupBy(stanceChanges.userId),
          db
            .select({ userId: entries.authorId, at: sql<Date>`min(${entries.createdAt})`.mapWith(entries.createdAt) })
            .from(entries)
            .innerJoin(rootTopic, rootTopicOn())
            .where(and(visibleWithTopic(), inArray(entries.kind, ["topic", "reply"]), inArray(entries.authorId, ids)))
            .groupBy(entries.authorId),
        ]);
  const firstStance = new Map(stanceRows.map((r) => [r.userId, r.at.getTime()]));
  const firstPost = new Map(postRows.map((r) => [r.userId, r.at.getTime()]));
  const window = FIRST_PARTICIPATION_DAYS * DAY_MS;
  return starts.map((cohortWeek) => {
    const cohort = members.filter((m) => weekIndexOf(m.startAt, cohortWeek) === 0);
    if (cohortWeek.getTime() + WEEK_MS + window > now.getTime()) return { cohortWeek, stance: rateCell(0, 0, 0), post: rateCell(0, 0, 0) };
    const within = (first: Map<string, number>) => cohort.filter((m) => (first.get(m.userId) ?? Infinity) <= m.startAt.getTime() + window).length;
    return { cohortWeek, stance: rateCell(within(firstStance), cohort.length, cohort.length), post: rateCell(within(firstPost), cohort.length, cohort.length) };
  });
}

// ---- Which language areas move toward which. Operator only; across posts and questions, never per question. ----

// One number for a pair of areas: numerator / denominator (not observed when the denominator is 0); people = the members behind the number.
export type AreaCell = { numerator: number; denominator: number; people: number };

export type DirectionMatrix = {
  from: Date;
  to: Date;
  // For each area of the authors (the author's home area when the post was written): the number of posts that were reacted to and the number of their authors.
  rows: Array<{ authorArea: Area; entries: number; authors: number }>;
  // Insightful: rows are the area of the author, columns the area of the member who pressed it; the denominator is the row total of Insightful.
  insightful: Array<{ authorArea: Area; reactorArea: Area } & AreaCell>;
  // Replies: rows are the area of the author of the post replied to (the parent, or the topic), columns the area of the replier; the denominator is the row total of replies.
  replies: Array<{ authorArea: Area; reactorArea: Area } & AreaCell>;
};

const areaOrder = (a: string) => AREAS.indexOf(a as Area);

// Which areas react to the posts of which areas, over the last `weeks` weeks (one total: the weekly shares without a direction are in the cross-language rates above). A reply to one's own post,
// a post without an author_area, a reply without a replier's area, members under exclude_reactions and hidden or deleted posts (the post reacted to and the reply) do not count.
// Only the cells with a number are returned; the diagonal (the same area) is a cell like any other.
export async function crossAreaDirectionMatrix(db: Db, now: Date, weeks = 8): Promise<DirectionMatrix> {
  const from = observationWeeks(now, weeks)[0];
  const target = alias(entries, "reply_target");
  const [pressed, replied] = await Promise.all([
    db
      .select({ entryId: entries.id, authorId: entries.authorId, authorArea: entries.authorArea, reactorId: votes.voterId, reactorArea: votes.voterArea })
      .from(votes)
      .innerJoin(entries, eq(entries.id, votes.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .innerJoin(profiles, and(eq(profiles.userId, votes.voterId), isNull(profiles.reactionsExcludedAt)))
      .where(and(visibleWithTopic(), isNotNull(entries.authorArea), sql`${votes.voterId} <> ${entries.authorId}`, gte(votes.createdAt, from), lte(votes.createdAt, now))),
    db
      .select({ entryId: target.id, authorId: target.authorId, authorArea: target.authorArea, reactorId: entries.authorId, reactorArea: entries.authorArea })
      .from(entries)
      .innerJoin(rootTopic, rootTopicOn())
      .innerJoin(target, and(eq(target.id, sql`coalesce(${entries.parentId}, ${entries.threadId})`), isNull(target.deletedAt), isNull(target.hiddenAt)))
      .innerJoin(profiles, and(eq(profiles.userId, entries.authorId), isNull(profiles.reactionsExcludedAt)))
      .where(
        and(
          visibleWithTopic(),
          eq(entries.kind, "reply"),
          isNotNull(target.authorArea),
          isNotNull(entries.authorArea),
          sql`${entries.authorId} <> ${target.authorId}`,
          gte(entries.createdAt, from),
          lte(entries.createdAt, now),
        ),
      ),
  ]);
  type Row = { entryId: number; authorId: string; authorArea: string | null; reactorId: string; reactorArea: string | null };
  const cells = (rows: Row[]) => {
    const rowTotal = new Map<string, number>();
    const byPair = new Map<string, { authorArea: Area; reactorArea: Area; numerator: number; people: Set<string> }>();
    for (const r of rows) {
      if (r.authorArea === null || r.reactorArea === null) continue;
      rowTotal.set(r.authorArea, (rowTotal.get(r.authorArea) ?? 0) + 1);
      const key = `${r.authorArea}|${r.reactorArea}`;
      const cell = byPair.get(key) ?? { authorArea: r.authorArea as Area, reactorArea: r.reactorArea as Area, numerator: 0, people: new Set<string>() };
      cell.numerator += 1;
      cell.people.add(r.reactorId);
      byPair.set(key, cell);
    }
    return [...byPair.values()]
      .sort((x, y) => areaOrder(x.authorArea) - areaOrder(y.authorArea) || areaOrder(x.reactorArea) - areaOrder(y.reactorArea))
      .map((c) => ({ authorArea: c.authorArea, reactorArea: c.reactorArea, numerator: c.numerator, denominator: rowTotal.get(c.authorArea) ?? 0, people: c.people.size }));
  };
  // The posts that were reacted to (in either way), once each, by the area of their author.
  const reactedTo = new Map<number, { area: string; authorId: string }>();
  for (const r of [...pressed, ...replied]) if (r.authorArea !== null) reactedTo.set(r.entryId, { area: r.authorArea, authorId: r.authorId });
  const rowAreas = new Map<string, { entries: number; authors: Set<string> }>();
  for (const v of reactedTo.values()) {
    const row = rowAreas.get(v.area) ?? { entries: 0, authors: new Set<string>() };
    row.entries += 1;
    row.authors.add(v.authorId);
    rowAreas.set(v.area, row);
  }
  return {
    from,
    to: now,
    rows: [...rowAreas.entries()].sort(([x], [y]) => areaOrder(x) - areaOrder(y)).map(([area, v]) => ({ authorArea: area as Area, entries: v.entries, authors: v.authors.size })),
    insightful: cells(pressed),
    replies: cells(replied),
  };
}

// The distance between the stance distributions of two language areas, at the end of each week. questions = the questions where both areas have a stance at that time (the denominator),
// sumDistance = the sum of their distances (the numerator), mean = sumDistance / questions (null: not observed), people = the members counted in either area in those questions.
export type StanceDistancePoint = { weekEnd: Date; a: Area; b: Area; questions: number; people: number; sumDistance: number; mean: number | null };

// Total variation distance between two distributions of positions given as counts (half the sum of the absolute differences of the shares: 0 for the same distribution, 1 for the opposite).
export function totalVariationDistance(x: Record<Position, number>, y: Record<Position, number>): number {
  const nx = POSITIONS.reduce((s, p) => s + x[p], 0);
  const ny = POSITIONS.reduce((s, p) => s + y[p], 0);
  return POSITIONS.reduce((s, p) => s + Math.abs(x[p] / nx - y[p] / ny), 0) / 2;
}

// The stance of each member on each question at the end of each of the last `weeks` weeks (the end of this week is `now`), rebuilt from stance_changes: the last row before that moment
// (to_position null: no stance). The area is the one copied on that row. The pairs of areas are taken across questions: one point per pair and week, never a question's own numbers.
// Pairs of areas that never had a question with stances from both in the period are not returned. A week without such a question is a point with mean null.
// A member who deletes their record disappears from the past weeks too.
export async function stanceDistanceByAreaPair(db: Db, now: Date, weeks = 8): Promise<StanceDistancePoint[]> {
  const starts = observationWeeks(now, weeks);
  const rows = await db
    .select({ questionId: stanceChanges.questionId, userId: stanceChanges.userId, position: stanceChanges.toPosition, area: stanceChanges.area, at: stanceChanges.createdAt })
    .from(stanceChanges)
    .innerJoin(rootTopic, and(eq(rootTopic.id, stanceChanges.questionId), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt)))
    .innerJoin(profiles, and(eq(profiles.userId, stanceChanges.userId), isNull(profiles.reactionsExcludedAt)))
    .where(lte(stanceChanges.createdAt, now))
    .orderBy(stanceChanges.createdAt, stanceChanges.id);
  const current = new Map<string, { questionId: number; userId: string; position: Position | null; area: Area }>();
  type PairSum = { a: Area; b: Area; questions: number; sum: number; people: Set<string> };
  const perWeek: Array<Map<string, PairSum>> = [];
  let cursor = 0;
  starts.forEach((start, k) => {
    const last = k === starts.length - 1;
    const end = last ? now : new Date(start.getTime() + WEEK_MS);
    while (cursor < rows.length && (last ? rows[cursor].at.getTime() <= end.getTime() : rows[cursor].at.getTime() < end.getTime())) {
      const r = rows[cursor++];
      current.set(`${r.questionId}:${r.userId}`, { questionId: r.questionId, userId: r.userId, position: r.position as Position | null, area: r.area as Area });
    }
    // Per question and area: the counts of the positions and the members.
    const byQuestion = new Map<number, Map<Area, { counts: Record<Position, number>; users: string[] }>>();
    for (const c of current.values()) {
      if (c.position === null) continue;
      const areas = byQuestion.get(c.questionId) ?? new Map<Area, { counts: Record<Position, number>; users: string[] }>();
      const cell = areas.get(c.area) ?? { counts: { agree: 0, disagree: 0, neither: 0 }, users: [] };
      cell.counts[c.position] += 1;
      cell.users.push(c.userId);
      areas.set(c.area, cell);
      byQuestion.set(c.questionId, areas);
    }
    const pairs = new Map<string, PairSum>();
    for (const areas of byQuestion.values()) {
      const present = [...areas.keys()].sort((x, y) => areaOrder(x) - areaOrder(y));
      for (let i = 0; i < present.length; i++)
        for (let j = i + 1; j < present.length; j++) {
          const [a, b] = [present[i], present[j]];
          const key = `${a}|${b}`;
          const pair = pairs.get(key) ?? { a, b, questions: 0, sum: 0, people: new Set<string>() };
          pair.questions += 1;
          pair.sum += totalVariationDistance(areas.get(a)!.counts, areas.get(b)!.counts);
          for (const u of [...areas.get(a)!.users, ...areas.get(b)!.users]) pair.people.add(u);
          pairs.set(key, pair);
        }
    }
    perWeek.push(pairs);
  });
  const keys = [...new Set(perWeek.flatMap((m) => [...m.keys()]))].sort((x, y) => {
    const [xa, xb] = x.split("|");
    const [ya, yb] = y.split("|");
    return areaOrder(xa) - areaOrder(ya) || areaOrder(xb) - areaOrder(yb);
  });
  return keys.flatMap((key) => {
    const [a, b] = key.split("|") as [Area, Area];
    return starts.map((start, k): StanceDistancePoint => {
      const weekEnd = k === starts.length - 1 ? now : new Date(start.getTime() + WEEK_MS);
      const pair = perWeek[k].get(key);
      return pair
        ? { weekEnd, a, b, questions: pair.questions, people: pair.people.size, sumDistance: pair.sum, mean: pair.sum / pair.questions }
        : { weekEnd, a, b, questions: 0, people: 0, sumDistance: 0, mean: null };
    });
  });
}

// The first stances by area: for each member and question, the oldest row of the stance changes is the first stance (what the member thought before the reasons and the numbers moved them;
// a re-choice after a withdrawal is not a first stance). Counted by the area copied on that row, over the first stances of the last `weeks` weeks, across questions: never per question.
// counts: for each position, numerator = the first stances with it, denominator = all first stances of the area, people = the members who chose it first. Areas without a first stance are not returned.
export type FirstStanceRow = { area: Area; questions: number; people: number; counts: Record<Position, AreaCell> };
export async function firstStancesByArea(db: Db, now: Date, weeks = 8): Promise<FirstStanceRow[]> {
  const from = observationWeeks(now, weeks)[0];
  const rows = await db
    .selectDistinctOn([stanceChanges.questionId, stanceChanges.userId], {
      questionId: stanceChanges.questionId,
      userId: stanceChanges.userId,
      position: stanceChanges.toPosition,
      area: stanceChanges.area,
      at: stanceChanges.createdAt,
    })
    .from(stanceChanges)
    .innerJoin(rootTopic, and(eq(rootTopic.id, stanceChanges.questionId), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt)))
    .innerJoin(profiles, and(eq(profiles.userId, stanceChanges.userId), isNull(profiles.reactionsExcludedAt)))
    .where(lte(stanceChanges.createdAt, now))
    .orderBy(stanceChanges.questionId, stanceChanges.userId, stanceChanges.createdAt, stanceChanges.id);
  type Acc = { questions: Set<number>; people: Set<string>; positions: Record<Position, { n: number; people: Set<string> }> };
  const areaTotals = new Map<string, Acc>();
  for (const r of rows) {
    if (r.at.getTime() < from.getTime() || r.position === null) continue;
    const acc =
      areaTotals.get(r.area) ??
      ({ questions: new Set<number>(), people: new Set<string>(), positions: { agree: { n: 0, people: new Set<string>() }, disagree: { n: 0, people: new Set<string>() }, neither: { n: 0, people: new Set<string>() } } } satisfies Acc);
    acc.questions.add(r.questionId);
    acc.people.add(r.userId);
    const cell = acc.positions[r.position as Position];
    cell.n += 1;
    cell.people.add(r.userId);
    areaTotals.set(r.area, acc);
  }
  return [...areaTotals.entries()]
    .sort(([x], [y]) => areaOrder(x) - areaOrder(y))
    .map(([area, acc]) => {
      const total = POSITIONS.reduce((s, p) => s + acc.positions[p].n, 0);
      const counts = Object.fromEntries(POSITIONS.map((p) => [p, { numerator: acc.positions[p].n, denominator: total, people: acc.positions[p].people.size }])) as Record<Position, AreaCell>;
      return { area: area as Area, questions: acc.questions.size, people: acc.people.size, counts };
    });
}

// The original language of the questions (topics that ask for stances, alternative framings included; hidden and deleted ones are not counted), by the week they were asked and over the
// whole period (weekStart null). numerator = the questions in that language, denominator = all questions of the week (or the period), people = the members who asked a question in that language.
// Only the languages with a question are returned; a week without a question has no row (not observed).
export type QuestionLangRow = { weekStart: Date | null; lang: Lang } & AreaCell;
export async function questionLangComposition(db: Db, now: Date, weeks = 8): Promise<QuestionLangRow[]> {
  const starts = observationWeeks(now, weeks);
  const rows = await db
    .select({ lang: entries.lang, authorId: entries.authorId, createdAt: entries.createdAt })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(visibleWithTopic(), eq(entries.kind, "topic"), eq(entries.asksStance, true), gte(entries.createdAt, starts[0]), lte(entries.createdAt, now)));
  const langOrder = (l: string) => LANGS.indexOf(l as Lang);
  const compose = (subset: typeof rows, weekStart: Date | null): QuestionLangRow[] => {
    const byLang = new Map<string, { n: number; people: Set<string> }>();
    for (const r of subset) {
      const cell = byLang.get(r.lang) ?? { n: 0, people: new Set<string>() };
      cell.n += 1;
      cell.people.add(r.authorId);
      byLang.set(r.lang, cell);
    }
    return [...byLang.entries()].sort(([x], [y]) => langOrder(x) - langOrder(y)).map(([lang, v]) => ({ weekStart, lang: lang as Lang, numerator: v.n, denominator: subset.length, people: v.people.size }));
  };
  return [...starts.flatMap((start, k) => compose(rows.filter((r) => weekIndexOf(r.createdAt, starts[0]) === k), start)), ...compose(rows, null)];
}

export type Metrics = {
  now: Date;
  crossAreaReplyRate: WeeklyCrossAreaRate[];
  crossAreaInsightful: Awaited<ReturnType<typeof crossAreaInsightfulRate>>;
  crossAreaUpdate: Awaited<ReturnType<typeof crossAreaUpdateRate>>;
  activeMembers: Awaited<ReturnType<typeof weeklyActiveMembers>>;
  retention: Awaited<ReturnType<typeof fourWeekRetention>>;
  firstParticipation: Awaited<ReturnType<typeof firstParticipation>>;
  directionMatrix: DirectionMatrix;
  stanceDistance: StanceDistancePoint[];
  firstStances: FirstStanceRow[];
  questionLangs: QuestionLangRow[];
  sustainedWriters: AreaCount[];
  reports: ReportStats;
  aiAssistance: AiAssistanceRow[];
  postsByVia: ViaRow[];
};

export async function getMetrics(db: Db, now: Date = new Date()): Promise<Metrics> {
  const [crossRate, insightful, update, active, retention, first, matrix, distance, firstStances, questionLangs, writers, reports, ai, via] = await Promise.all([
    crossAreaReplyRate(db, now),
    crossAreaInsightfulRate(db, now),
    crossAreaUpdateRate(db, now),
    weeklyActiveMembers(db, now),
    fourWeekRetention(db, now),
    firstParticipation(db, now),
    crossAreaDirectionMatrix(db, now),
    stanceDistanceByAreaPair(db, now),
    firstStancesByArea(db, now),
    questionLangComposition(db, now),
    sustainedWritersByArea(db, now),
    reportStats(db),
    aiAssistanceByArea(db),
    postsByVia(db),
  ]);
  return {
    now,
    crossAreaReplyRate: crossRate,
    crossAreaInsightful: insightful,
    crossAreaUpdate: update,
    activeMembers: active,
    retention,
    firstParticipation: first,
    directionMatrix: matrix,
    stanceDistance: distance,
    firstStances,
    questionLangs,
    sustainedWriters: writers,
    reports,
    aiAssistance: ai,
    postsByVia: via,
  };
}
