import { sql, type SQLWrapper } from "drizzle-orm";
import { profiles } from "./db/schema";
import { DELETED_MEMBER_HANDLE, DELETED_MEMBER_ID } from "./deleted-member";

export function retainedAuthorColumn(authorId: SQLWrapper, handle: SQLWrapper = profiles.handle, alias = "author_handle") {
  return sql<string | null>`case when ${authorId} = ${DELETED_MEMBER_ID} then ${DELETED_MEMBER_HANDLE} else ${handle} end`.as(alias);
}
