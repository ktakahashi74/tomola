import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { and, eq } from "drizzle-orm";
import { data, redirect } from "react-router";
import type { Route } from "./+types/nushi-request";
import { getReader } from "~/lib/auth/session.server";
import { nushiAnswers, nushiRequests, notifications } from "~/lib/db/schema";
import { replyLocation } from "~/lib/entries.server";

// Notification links contain only the request ID, never answer text.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user } = await getReader(request);
  const [row] = await db.select().from(nushiRequests).where(eq(nushiRequests.id, params.id));
  const [notice] = row && user ? await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.nushiRequestId, row.id), eq(notifications.userId, user.id))).limit(1) : [];
  if (!row) throw data("Not found", { status: 404 });
  const [answer] = await db.select({ id: nushiAnswers.id }).from(nushiAnswers).where(eq(nushiAnswers.requestId, row.id));
  if (answer) throw redirect(`/nushi/${answer.id}`, { headers: { "Cache-Control": "private, no-store" } });
  if (row.callerId !== user?.id && !notice) throw data("Not found", { status: 404 });
  const href = row.entryId === row.threadId ? `/t/${row.threadId}` : await replyLocation(db, row.threadId, row.entryId);
  throw redirect(href, { headers: { "Cache-Control": "private, no-store" } });
}

export const middleware = [privateCacheMiddleware];
