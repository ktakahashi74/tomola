import { replyPagesOf } from "~/lib/reply-pages.server";
import { replyLocationAt } from "~/lib/entries.server";
import type { Db } from "~/lib/db/client.server";
import { replyLocation } from "~/lib/entries.server";
import { appealHref, isContentKind } from "~/lib/notifications";
import { listNotifications, type NotificationItem } from "~/lib/notifications.server";

export async function notificationDestination(db: Db, userId: string, id: number, target: string | null) {
  const [notification] = (await listNotifications(db, userId, { id, limit: 1 })).items;
  return notification ? target === "appeal" ? appealHref(notification) : notificationHref(db, notification) : null;
}

export async function notificationHref(db: Db, n: NotificationItem, pages?: ReadonlyMap<number, number>) {
  if (n.kind === "translation_report_result") {
    if (!n.translationResult || n.unavailable || n.entryId === null || n.threadId === null) return null;
    const path = n.entryId === n.threadId ? `/t/${n.threadId}` : pages ? replyLocationAt(n.threadId, n.entryId, pages.get(n.entryId) ?? 1) : await replyLocation(db, n.threadId, n.entryId);
    const url = new URL(path, "http://localhost");
    url.searchParams.set("lang", n.translationResult.lang);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (n.kind === "response_to_topic") return n.entryId !== null && !n.unavailable ? `/t/${n.entryId}` : null;
  return n.chat ? `/v/${n.chat.slug}/chat?at=${n.chat.id}#chat-${n.chat.id}` : n.village ? `/v/${n.village.slug}` : n.kind === "followed_thread" ? n.followedHref : n.threadId !== null && n.entryId !== null && (isContentKind(n.kind) || (n.kind === "moderation" && (n.action === "hide" || n.action === "fix_entry")))
            ? n.entryId === n.threadId
              ? `/t/${n.threadId}`
              : (pages ? replyLocationAt(n.threadId, n.entryId, pages.get(n.entryId) ?? 1) : await replyLocation(db, n.threadId, n.entryId))
            : n.threadId !== null && n.latestUnavailable
              ? `/t/${n.threadId}`
              : null;
}

export async function notificationHrefs(db: Db, items: readonly NotificationItem[]): Promise<Map<number, string | null>> {
  const targets = items.flatMap(n => n.threadId !== null && n.entryId !== null && n.entryId !== n.threadId && !n.chat && !n.village && n.kind !== "followed_thread" && n.kind !== "response_to_topic" && (isContentKind(n.kind) || n.kind === "translation_report_result" || n.kind === "moderation" && (n.action === "hide" || n.action === "fix_entry")) ? [{ id: n.entryId, threadId: n.threadId }] : []);
  const pages = await replyPagesOf(db, targets);
  return new Map(await Promise.all(items.map(async n => [n.id, await notificationHref(db, n, pages)] as const)));
}
