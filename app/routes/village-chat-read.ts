import { data } from "react-router";
import type { Route } from "./+types/village-chat-read";
import { requireMember } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { chatSequence } from "~/lib/village-chat";
import { ChatError, chatUnreadCounts, markChatRead } from "~/lib/village-chat.server";
import { countUnreadNotifications } from "~/lib/notifications.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (!villageChatEnabled()) throw data("Not found", { status: 404 });
  const { db, user } = await requireMember(request);
  const form = await request.formData();
  const seq = chatSequence(form.get("seq"));
  if (seq === null || form.get("intent") !== "read") throw data("Bad request", { status: 400 });
  const rate = await hitMemberLimit(db, "chat-read", user.id);
  if (!rate.allowed) return Response.json({ error: "limit" }, { status: 429, headers: { ...CHAT_PRIVATE_HEADERS, ...rateLimitHeaders(rate) } });
  try {
    const cleared = await markChatRead(db, user.id, params.slug, seq);
    const [unread, notifications] = await Promise.all([chatUnreadCounts(db, user.id, { excludeEnded: true }), countUnreadNotifications(db, user.id)]);
    const unreadCounts = Object.fromEntries(unread);
    return Response.json({ ok: true, unreadCounts, notifications }, { headers: {
      ...CHAT_PRIVATE_HEADERS, "X-Chat-Read-Notices": cleared > 0 ? "1" : "0", "X-Chat-Unread-Counts": JSON.stringify(unreadCounts), "X-Unread-Notifications": String(notifications),
    } });
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    throw data(error.code, { status: error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 403, headers: CHAT_PRIVATE_HEADERS });
  }
}
