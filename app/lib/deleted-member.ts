import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";

// One shared identity for every departed member; never create per-person aliases.
export const DELETED_MEMBER_ID = "deleted-member";
export const DELETED_MEMBER_EMAIL = "deleted-member@invalid.invalid";
export function isDeletedIdentity(id?: string | null, email?: unknown): boolean {
  return id === DELETED_MEMBER_ID || (typeof email === "string" && email.trim().toLowerCase() === DELETED_MEMBER_EMAIL);
}
export const DELETED_MEMBER_HANDLE = "[deleted]";

export function authorLabel(handle: string | null): string {
  return handle === DELETED_MEMBER_HANDLE ? m.account_delete_member() : `@${handle ?? "?"}`;
}

export function namedAuthorLabel(handle: string | null | undefined, name: string | null | undefined, locale?: Locale): string {
  return handle === DELETED_MEMBER_HANDLE ? m.account_delete_member({}, { locale }) : name ? `${name} (@${handle ?? "?"})` : `@${handle ?? "?"}`;
}
