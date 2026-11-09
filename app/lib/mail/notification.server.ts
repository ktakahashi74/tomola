import type { TranslationReportResult } from "../translation-report-results";
import { translationReportResultText } from "../translation-report-result-text";
import { namedAuthorLabel } from "~/lib/deleted-member";
import { reasonLabelFor } from "~/lib/mail/reason-label";
import type { MailMessage } from "~/lib/mail/mail.server";
import type { ModerationAction, ReportReason, AppealStatus } from "~/lib/moderation";
import type { NotificationKind } from "~/lib/notifications";
import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";
import { localizedLanguageLabel } from "~/lib/language-label";
import type { Lang } from "~/lib/languages";

// Plain-text notification mail in the recipient's profiles.ui_locale, in the same module location as magic-link.server.ts.
// A followed_thread mail tells how many replies were merged (count) and shows the author, the excerpt and the place of the latest reply. When the latest reply is hidden
// or deleted, it leaves the author and the excerpt out (no handle) and points to the topic.
// Reply mail includes up to 200 characters, translated into the recipient's display language if available, otherwise original, and an absolute thread URL without a token.
// moderation/appeal_decided mail omits post content: only action type, reason category and notification-page URL.

// One item of a mail. A reply notification has handle, title (the one line that names the topic: its title, or the beginning of its body when it has no title; an empty string means a body with no text), excerpt and url.
// A moderation action and the result of an appeal have action, reason, until, appealStatus and url.
export type MailItem = {
  translationResult?: TranslationReportResult;
  automatic?: boolean;
  kind: NotificationKind;
  url: string;
  villageName?: string;
  handle?: string;
  name?: string | null;
  title?: string;
  excerpt?: string;
  action?: ModerationAction | null;
  reason?: ReportReason | null;
  until?: Date | null;
  appealStatus?: AppealStatus | null;
  // Whether an overturned action was actually reverted; false if nothing remained to restore.
  appealReversed?: boolean | null;
  // followed_thread: how many replies are merged into the notification.
  count?: number;
  replyLanguage?: Lang;
};

export const EXCERPT_CHARS = 200;
// Maximum daily-digest items; additional items are represented only by a count.
export const DIGEST_MAX_ITEMS = 50;

// Collapse excerpt whitespace, truncate to 200 code points, and append 「…」 if truncated.
export function excerptOf(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

const dateTime = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

// One item's body, separate from subject.
export function itemText(item: MailItem, locale: Locale): string {
  const o = { locale };
  const reason = reasonLabelFor(item.reason ?? "other", locale);
  switch (item.kind) {
    case "translation_report_result":
      return `${item.translationResult ? translationReportResultText(item.translationResult, item.title, locale) : m.notification_content_unavailable({}, o)}\n${item.url}`;
    case "chat_mention":
      return item.villageName === undefined ? m.mail_item_chat_mention({ url: item.url }, o) : m.mail_item_chat_mention_named({ name: item.villageName, url: item.url }, o);
    case "village_added":
      return m.mail_item_village_added({ actor: namedAuthorLabel(item.handle, item.name, locale), url: item.url }, o);
    case "village_invite":
    case "village_removed":
    case "village_owner_changed":
      return m.mail_item_village({ url: item.url }, o);
    case "reply_to_topic":
      if (item.replyLanguage) return m.mail_item_reply_to_topic_language({ handle: item.handle ?? "?", title: item.title || m.headline_empty({}, o), language: localizedLanguageLabel(item.replyLanguage, locale), excerpt: item.excerpt ?? "", url: item.url }, o);
      return m.mail_item_reply_to_topic({ handle: item.handle ?? "?", title: item.title || m.headline_empty({}, o), excerpt: item.excerpt ?? "", url: item.url }, o);
    case "response_to_topic":
      return m.mail_item_response_to_topic({ handle: item.handle ?? "?", title: item.title || m.headline_empty({}, o), excerpt: item.excerpt ?? "", url: item.url }, o);
    case "reply_to_reply":
      if (item.replyLanguage) return m.mail_item_reply_to_reply_language({ handle: item.handle ?? "?", title: item.title || m.headline_empty({}, o), language: localizedLanguageLabel(item.replyLanguage, locale), excerpt: item.excerpt ?? "", url: item.url }, o);
      return m.mail_item_reply_to_reply({ handle: item.handle ?? "?", title: item.title || m.headline_empty({}, o), excerpt: item.excerpt ?? "", url: item.url }, o);
    case "mention":
      return m.mail_item_mention({ handle: item.handle ?? "?", title: item.title || m.headline_empty({}, o), excerpt: item.excerpt ?? "", url: item.url }, o);
    case "followed_thread":
      // Without a handle the latest reply is hidden or deleted: tell the count and the topic only. A topic without a title is named by the line the caller built (see headline_empty).
      return item.handle === undefined
        ? m.mail_item_followed_thread_nolatest({ count: item.count ?? 1, title: item.title || m.headline_empty({}, o), url: item.url }, o)
        : m.mail_item_followed_thread({ count: item.count ?? 1, handle: item.handle, title: item.title || m.headline_empty({}, o), excerpt: item.excerpt ?? "", url: item.url }, o);
    case "moderation":
      if (item.automatic) return m.mail_moderation_automatic({ url: item.url }, o);
      if (item.action === "restore_village_icon") return m.mail_village_icon_restored({ url: item.url }, o);
      if (item.action === "clear_village_icon") return m.mail_village_icon_removed({ reason, url: item.url }, o);
      if (item.action === "clear_avatar") return m.mail_avatar_removed({ reason, url: item.url }, o);
      if (item.action === "clear_display_name") return m.mail_display_name_removed({ reason, url: item.url }, o);
      if (item.action === "hide_chat" || item.action === "unhide_chat") {
        const text = item.action === "hide_chat" ? m.mail_item_moderation_hide_chat({ reason, url: item.url }, o) : m.mail_item_moderation_unhide_chat({ url: item.url }, o);
        return item.villageName === undefined ? text : `${text} ${m.mail_chat_public_village({ name: item.villageName }, o)}`;
      }
      if (item.action === "fix_village") return m.mail_item_moderation_fix_village({ reason, url: item.url }, o);
      if (item.action === "end_village") return m.mail_item_moderation_end_village({ reason, url: item.url }, o);
      if (item.action === "unfix_village") return m.mail_item_moderation_unfix_village({ url: item.url }, o);
      if (item.action === "reopen_village") return m.mail_item_moderation_reopen_village({ url: item.url }, o);
      if (item.action === "unsuspend") return m.mail_item_moderation_unsuspend({ url: item.url }, o);
      if (item.action === "suspend") return m.mail_item_moderation_suspend({ until: item.until ? dateTime(item.until) : "", reason, url: item.url }, o);
      if (item.action === "delete") return m.mail_item_moderation_delete({ reason, url: item.url }, o);
      if (item.action === "exclude_reactions") return m.mail_item_moderation_exclude({ reason, url: item.url }, o);
      if (item.action === "include_reactions") return m.mail_item_moderation_include({ url: item.url }, o);
      if (item.action === "fix_entry") return m.mail_item_moderation_fix({ reason, url: item.url }, o);
      return m.mail_item_moderation_hide({ reason, url: item.url }, o);
    case "appeal_decided":
      if (item.appealStatus === "overturned") {
        return item.appealReversed === false ? m.mail_item_appeal_overturned_nochange({ url: item.url }, o) : m.mail_item_appeal_overturned({ url: item.url }, o);
      }
      return m.mail_item_appeal_upheld({ url: item.url }, o);
  }
}

function subjectFor(item: MailItem, locale: Locale): string {
  const o = { locale };
  switch (item.kind) {
    case "translation_report_result": return m.mail_subject_translation_report_result({}, o);
    case "chat_mention":
      return m.mail_subject_chat_mention({}, o);
    case "village_added":
    case "village_invite":
    case "village_removed":
    case "village_owner_changed":
      return m.mail_subject_village({}, o);
    case "reply_to_topic":
      return m.mail_subject_reply_to_topic({ handle: item.handle ?? "?" }, o);
    case "response_to_topic":
      return m.mail_subject_response_to_topic({ handle: item.handle ?? "?" }, o);
    case "reply_to_reply":
      return m.mail_subject_reply_to_reply({ handle: item.handle ?? "?" }, o);
    case "mention":
      return m.mail_subject_mention({ handle: item.handle ?? "?" }, o);
    case "followed_thread":
      return m.mail_subject_followed_thread({}, o);
    case "moderation":
      return m.mail_subject_moderation({}, o);
    case "appeal_decided":
      return m.mail_subject_appeal({}, o);
  }
}

// Immediate mail, one message per notification. settingsUrl is the absolute /settings notification-settings URL.
export function notificationMail(input: { to: string; locale: Locale; item: MailItem; settingsUrl: string }): MailMessage {
  const o = { locale: input.locale };
  return {
    to: input.to,
    locale: input.locale,
    subject: subjectFor(input.item, input.locale),
    text: `${itemText(input.item, input.locale)}\n\n${m.mail_footer({ url: input.settingsUrl }, o)}\n`,
  };
}

// Daily digest, one message per recipient: items up to DIGEST_MAX_ITEMS, then remaining count more and allUrl to notifications.
export function digestMail(input: { to: string; locale: Locale; items: readonly MailItem[]; more: number; allUrl: string; settingsUrl: string }): MailMessage {
  const o = { locale: input.locale };
  const total = input.items.length + input.more;
  const parts = [m.mail_digest_intro({ count: total }, o), ...input.items.map((item) => itemText(item, input.locale))];
  if (input.more > 0) parts.push(m.mail_digest_more({ count: input.more, url: input.allUrl }, o));
  parts.push(m.mail_footer({ url: input.settingsUrl }, o));
  return { to: input.to, locale: input.locale, subject: m.mail_digest_subject({ count: total }, o), text: `${parts.join("\n\n")}\n` };
}
