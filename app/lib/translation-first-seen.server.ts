import { sql } from "drizzle-orm";
import { translations } from "./db/schema";

// Used only on conflict updates: a source revision gets its own first display,
// while corrections and retries of that revision retain the original timestamp.
export function firstSeenAtForSource(sourceHash: string | null, mentionRevision: number | null) {
  return sql<Date | null>`case when ${translations.sourceHash} is distinct from ${sourceHash} or ${translations.mentionRevision} is distinct from ${mentionRevision} then null else ${translations.firstSeenAt} end`;
}
