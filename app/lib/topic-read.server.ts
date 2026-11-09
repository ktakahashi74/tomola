import { and, eq, isNull } from "drizzle-orm";
import { entries } from "./db/schema";
import { getReader, getRequestViewer } from "./auth/session.server";
import { canSeeHidden } from "./roles.server";
import { markFollowedThreadRead } from "./follows.server";

const reads = new WeakMap<Request, Promise<void>>();
// The layout waits for the same operation as the topic loader before counting.
// Resource routes and unreadable topics never acknowledge notifications.
export function synchronizeTopicRead(request: Request): Promise<void> {
  let result = reads.get(request);
  if (!result) { result = acknowledge(request); reads.set(request, result); }
  return result;
}
async function acknowledge(request: Request): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const match = /^\/t\/([1-9]\d*)(?:\.data)?\/?$/.exec(new URL(request.url).pathname);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return;
  const { db, user } = await getReader(request);
  if (!user) return;
  const [topic] = await db.select({ hiddenAt: entries.hiddenAt, authorId: entries.authorId, lang: entries.lang }).from(entries)
    .where(and(eq(entries.id, Number(match[1])), eq(entries.kind, "topic"), isNull(entries.deletedAt)));
  if (!topic || topic.hiddenAt && !canSeeHidden(await getRequestViewer(request), topic)) return;
  await markFollowedThreadRead(db, user.id, Number(match[1]), new Date());
}
