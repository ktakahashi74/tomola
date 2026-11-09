import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { entries } from "~/lib/db/schema";

const childReply = alias(entries, "child_reply");

// A deleted reply needs a placeholder only while an undeleted reply refers to it.
// Search the whole thread, including moderation-hidden children on other pages.
export function hasUndeletedReply(): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${entries} as ${childReply}
    where ${childReply.parentId} = ${entries.id}
      and ${childReply.threadId} = ${entries.threadId}
      and ${childReply.kind} = 'reply'
      and ${childReply.deletedAt} is null
  )`;
}
