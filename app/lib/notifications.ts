// Notification enums shared by UI/server and DB CHECK generation in app/lib/db/schema.ts.
// reply_to_topic: reply to own topic; reply_to_reply: reply to own reply; moderation: action on own post/member (hide/delete/suspend,
// without actor identity). appeal_decided: result of an appeal.
// followed_thread: a new reply in a followed topic (merged into one row per member and topic while it is unread).
export const NOTIFICATION_KINDS = ["reply_to_topic", "reply_to_reply", "response_to_topic", "moderation", "appeal_decided", "followed_thread", "mention", "village_invite", "village_added", "village_removed", "village_owner_changed", "chat_mention", "chat_reply", "translation_report_result", "source_language_mismatch", "entry_translation_unavailable", "nushi_result", "nushi_cited"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const IN_APP_ONLY_KINDS = ["source_language_mismatch", "entry_translation_unavailable"] as const satisfies readonly NotificationKind[];
export type InAppOnlyKind = (typeof IN_APP_ONLY_KINDS)[number];
export const isInAppOnlyKind = (kind: string): kind is InAppOnlyKind => (IN_APP_ONLY_KINDS as readonly string[]).includes(kind);
// Kinds that tell about the content of a post (hiding and deleting of the post, the excerpt and the link are shared).
export const CONTENT_KINDS = ["reply_to_topic", "reply_to_reply", "response_to_topic", "followed_thread", "mention"] as const satisfies readonly NotificationKind[];
export const isContentKind = (kind: string): kind is (typeof CONTENT_KINDS)[number] => (CONTENT_KINDS as readonly string[]).includes(kind);

// Email of notifications (a setting per member: /settings). auto (the default): each kind goes the way its default says (replies and mentions at once, everything else in the daily
// digest). immediate: every kind at once, one email each. daily: every kind in one digest a day (00:00 UTC). none: no email.
export const EMAIL_PREFS = ["auto", "immediate", "daily", "none"] as const;
export type EmailPref = (typeof EMAIL_PREFS)[number];
export const DEFAULT_EMAIL_PREF: EmailPref = "auto";
export const isEmailPref = (x: unknown): x is EmailPref => typeof x === "string" && (EMAIL_PREFS as readonly string[]).includes(x);

// Kinds sent immediately (through the existing 5-minute delay) when the preference is `auto`; every other kind goes to the daily digest.
//
export const AUTO_IMMEDIATE_KINDS = ["reply_to_topic", "reply_to_reply", "response_to_topic", "mention", "chat_mention", "chat_reply"] as const satisfies readonly NotificationKind[];

// How one notification is actually mailed, from the recipient's preference and the kind of the notification. SQL does not repeat this table:
// callers narrow by the preference and apply this function in JavaScript.
export function effectiveEmailMode(pref: EmailPref, kind: NotificationKind): "immediate" | "daily" | "none" {
  if (isInAppOnlyKind(kind)) return "none";
  if (pref !== "auto") return pref;
  return (AUTO_IMMEDIATE_KINDS as readonly string[]).includes(kind) ? "immediate" : "daily";
}

export function appealHref(n: { kind: NotificationKind; action: string | null; actionId: number | null }) {
  return ((n.kind === "moderation" && ["clear_village_icon", "clear_avatar", "clear_display_name", "hide", "hide_chat", "delete", "suspend", "exclude_reactions", "fix_entry", "fix_village", "end_village"].includes(n.action ?? "")) || n.kind === "appeal_decided") && n.actionId !== null ? `/appeal/${n.actionId}` : null;
}

export const CHAT_NOTIFICATION_KINDS = ["chat_mention", "chat_reply"] as const;
export const isChatNotification = (kind: string): boolean => (CHAT_NOTIFICATION_KINDS as readonly string[]).includes(kind);
