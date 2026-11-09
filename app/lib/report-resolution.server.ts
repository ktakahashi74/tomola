import { sql } from "drizzle-orm";
import { moderationActions, reports } from "./db/schema";

// Automatic actions and their report closures share the target and exact timestamp.
// NULL handled_by alone also occurs when an author deletes a post.
export function automaticallyResolvedReport() {
  return sql<boolean>`${reports.status} = 'resolved' and ${reports.handledBy} is null and exists (
    select 1 from ${moderationActions}
    where ${moderationActions.automatic} = true and ${moderationActions.createdAt} = ${reports.handledAt}
      and ((${moderationActions.action} = 'hide' and ${moderationActions.targetEntryId} = ${reports.entryId})
        or (${moderationActions.action} = 'hide_chat' and ${moderationActions.targetChatMessageId} = ${reports.chatMessageId}))
  )`;
}
