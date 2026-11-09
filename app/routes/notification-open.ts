import { pushOpeningIds } from "~/lib/push/opening.server";
import { data, redirect } from "react-router";
import { requireMember } from "~/lib/auth/session.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { notificationDestination } from "~/lib/notification-opening.server";
import { markNotificationRead, markThreadNotificationsRead } from "~/lib/notifications.server";
import { notifications } from "~/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/notification-open";

// A document link supports new tabs and no-JS navigation. Never cache a read
// receipt or let a speculative request consume it before the member opens it.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  await enforceMemberLimit(db, "notifications", user.id);
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw data("Bad request", { status: 400 });
  const push = new URL(request.url).searchParams.get("push");
  if (push !== null && !(await pushOpeningIds(db, user.id, push))?.includes(id)) throw data("Not found", { status: 404 });
  const href = await notificationDestination(db, user.id, id, new URL(request.url).searchParams.get("target"));
  if (!href) throw data("Not found", { status: 404 });
  const speculative = [request.headers.get("Purpose"), request.headers.get("Sec-Purpose")].some(value => /prefetch|prerender/i.test(value ?? ""));
  if (request.method === "GET" && !speculative && request.headers.get("Sec-Fetch-Site") !== "cross-site") {
    await markNotificationRead(db, user.id, id);
    // A grouped row stands for all the unread notices about one post: it opens at the oldest, and reads them all.
    if (new URL(request.url).searchParams.get("group") === "thread") {
      const [row] = await db.select({ threadId: notifications.threadId }).from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
      if (row?.threadId != null) await markThreadNotificationsRead(db, user.id, row.threadId);
    }
  }
  return redirect(href, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Robots-Tag": "noindex" } });
}
