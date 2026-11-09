import { PRINCIPLES_LANGS } from "./principles-languages";

export const SHARED_VILLAGE_KINDS = ["open", "invite_public"] as const;
export const isSharedVillageKind = (kind: string): boolean => (SHARED_VILLAGE_KINDS as readonly string[]).includes(kind);
export const VILLAGE_CREATE_LIMIT = 5;
export const VILLAGE_SLUG_MAX = 63;
export const VILLAGE_NAME_MAX = 120;
export const VILLAGE_DESCRIPTION_MAX = 2000;
// A translation may run longer than its source; these are the limits for a translated name and description.
export const VILLAGE_TRANSLATED_NAME_MAX = VILLAGE_NAME_MAX * 2;
export const VILLAGE_TRANSLATED_DESCRIPTION_MAX = VILLAGE_DESCRIPTION_MAX * 2;
export const VILLAGE_REMOVAL_REASON_MAX = 2000;
export const VILLAGE_DECLINE_LIMIT = 2;
export const VILLAGE_INVITE_PAUSE_DAYS = 30;
export const VILLAGE_INVITE_DAILY_LIMIT = 20;
export const VILLAGE_REINVITE_HOURS = 24;
export const VILLAGE_ROSTER_PAGE_SIZE = 50;
export const VILLAGE_INVITE_KINDS = ["join", "owner"] as const;
export const VILLAGE_INVITE_STATES = ["pending", "accepted", "declined", "cancelled"] as const;
export type VillageInviteKind = typeof VILLAGE_INVITE_KINDS[number];

// Reserve supported language tags even when that language is currently disabled.
const reserved = new Set([
  ...PRINCIPLES_LANGS.map(lang => lang.toLowerCase()),
  "home", "villages", "v", "new", "create", "edit", "end", "invite", "invites", "join", "leave",
  "login", "logout", "auth", "onboarding", "navigation-header", "api", "mcp", "signing", "passkeys",
  "preview", "media", "open-in-ai", "drafts", "vote", "mentions", "stance", "follow", "following",
  "latest", "search", "changes", "manifest", "glossary", "llms", "ai", "help", "offline",
  "principles", "why", "admin", "settings", "moderation", "mod", "appeal", "suspended", "a", "t", "c", "u",
]);
export function validVillageSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= VILLAGE_SLUG_MAX
    && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && !/^[a-f0-9]{32}$/.test(value) && !reserved.has(value);
}
// Preserve script-shaping joiners while rejecting other format controls.
const forbiddenFormat = /(?![\u200c\u200d])\p{Cf}/u;
// Hangul fillers are letters, but do not provide a visible name.
const invisibleNameLetters = /[\u115f\u1160\u3164\uffa0]/u;
export function villageNameText(value: unknown, max = VILLAGE_NAME_MAX): string | null {
  if (typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(value)
    || forbiddenFormat.test(value) || invisibleNameLetters.test(value) || !/[\p{L}\p{N}]/u.test(value)) return null;
  return villageText(value, max, true);
}
export function villageDescriptionText(value: unknown, max = VILLAGE_DESCRIPTION_MAX): string | null {
  // CR/LF and script-shaping joiners are allowed; other controls are not.
  if (typeof value !== "string" || /[\p{Bidi_Control}\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || forbiddenFormat.test(value)) return null;
  return villageText(value, max);
}
export function villageText(value: unknown, max: number, required = false): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return (required && !text) || text.includes("\u0000") || [...text].length > max ? null : text;
}

// Markup that a translation of a plain-text name or description must not bring in: an HTML tag, a code fence, or a Markdown link or image (unless the source itself has some).
const translatedMarkup = /<\/?[a-z!][^>]*>|```|~~~|!?\[[^\]\n]*\]\([^)\n]*\)/i;
// A translated name: one line, no markup, within the limit; null when it cannot be shown.
export function translatedVillageName(value: unknown, source: string): string | null {
  const name = villageNameText(value, VILLAGE_TRANSLATED_NAME_MAX);
  return name === null || (translatedMarkup.test(name) && !translatedMarkup.test(source)) ? null : name;
}
export function translatedVillageDescription(value: unknown, source: string): string | null {
  const description = villageDescriptionText(value, VILLAGE_TRANSLATED_DESCRIPTION_MAX);
  return description === null || (translatedMarkup.test(description) && !translatedMarkup.test(source)) ? null : description;
}
