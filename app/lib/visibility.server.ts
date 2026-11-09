import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { entries, villages } from "~/lib/db/schema";
import { SHARED_VILLAGE_KINDS } from "~/lib/villages";
import type { Db } from "~/lib/db/client.server";

// Closed or unaddressable villages have no supported reading path. Fail closed everywhere,
// including signed-in/operator reads and exports, without requiring a join.
export const publicTopicPlace = (topic: { villageId: AnyPgColumn } = entries): SQL =>
  or(isNull(topic.villageId), sql`exists (select 1 from ${villages} where ${villages.id} = ${topic.villageId} and ${or(eq(villages.kind, "personal"), and(inArray(villages.kind, [...SHARED_VILLAGE_KINDS]), isNotNull(villages.slug)))})`)!;

// Shared definition of readable posts for observation, exports, and operator metrics: neither the entry itself nor the root topic is deleted or hidden.
// Replies become unreadable when their topic is hidden or deleted, even if the replies remain (as in thread views, Markdown, and search), so exclude them from counts.
// Usage: join entries with `rootTopic` (the thread's topic, or itself for topics) and include `visibleWithTopic` in where.

export const rootTopic = alias(entries, "root_topic");

// Join condition between entries and their rootTopic. A topic has null thread_id, so coalesce(thread_id, id) selects itself.
export const rootTopicOn = (): SQL => eq(rootTopic.id, sql`coalesce(${entries.threadId}, ${entries.id})`);

// Hidden-topic policy differs between ordinary reads and review queues, but
// every live-content path requires an existing, undeleted topic.
export const undeletedTopic = (topic: { kind: AnyPgColumn; deletedAt: AnyPgColumn } = entries): SQL =>
  and(eq(topic.kind, "topic"), isNull(topic.deletedAt))!;

export const visibleWithTopic = (): SQL =>
  and(isNull(entries.deletedAt), isNull(entries.hiddenAt), undeletedTopic(rootTopic), isNull(rootTopic.hiddenAt), publicTopicPlace(rootTopic)) as SQL;

// A visible reply remains readable under a hidden topic. Review its translation
// using that same policy; the root must exist and must never be deleted.
export const reviewableWithTopic = (): SQL =>
  and(isNull(entries.deletedAt), isNull(entries.hiddenAt), undeletedTopic(rootTopic), publicTopicPlace(rootTopic)) as SQL;

// Call inside a transaction. Lock the root before the post, matching deletion,
// then recheck review eligibility while holding both locks.
export async function lockReviewableEntry(db: Db, id: number, mode: "share" | "update" = "share") {
  const [peek] = await db.select({ threadId: entries.threadId }).from(entries).where(eq(entries.id, id));
  if (!peek) return undefined;
  const rootId = peek.threadId ?? id;
  // A topic correction locks this same row for update next. Serialize those
  // writers before upgrading, while corrections of distinct replies can share the root.
  await db.select({ id: entries.id }).from(entries).where(eq(entries.id, rootId))
    .for(mode === "update" && rootId === id ? "no key update" : "share");
  const [row] = await db.select({ entry: entries }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entries.id, id), reviewableWithTopic())).for(mode, { of: entries });
  return row?.entry;
}

// Exported post status: the entry's own state takes precedence, followed by the root topic's state.
export type EntryState = "visible" | "deleted" | "hidden" | "thread_deleted" | "thread_hidden";

export function entryState(row: { deletedAt: Date | null; hiddenAt: Date | null; topicDeletedAt: Date | null; topicHiddenAt: Date | null }): EntryState {
  if (row.deletedAt !== null) return "deleted";
  if (row.hiddenAt !== null) return "hidden";
  if (row.topicDeletedAt !== null) return "thread_deleted";
  if (row.topicHiddenAt !== null) return "thread_hidden";
  return "visible";
}
