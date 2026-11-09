import { getSessionUser } from "./auth/session.server";
import { getDb } from "./db/client.server";
import { getActiveMember } from "./members.server";
import { hitMemberLimit, rateLimitHeaders } from "./rate-limit.server";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { chatAccess } from "./village-chat.server";

export const CHAT_PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
export async function chatResourceMember(request: Request, slug: string, mode: "chat-changes" | "chat-events") {
  if (!villageChatEnabled()) throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  const user = await getSessionUser(request);
  if (!user) throw new Response("Unauthorized", { status: 401, headers: CHAT_PRIVATE_HEADERS });
  const db = await getDb();
  const profile = await getActiveMember(db, user.id);
  if (!profile) throw new Response("Unauthorized", { status: 401, headers: CHAT_PRIVATE_HEADERS });
  const rate = await hitMemberLimit(db, mode, user.id);
  if (!rate.allowed) throw new Response("Too many requests", { status: 429, headers: { ...CHAT_PRIVATE_HEADERS, ...rateLimitHeaders(rate) } });
  const access = await chatAccess(db, slug, user.id);
  if (!access?.consented) throw new Response("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  return { db, user, village: access.village, profile };
}
