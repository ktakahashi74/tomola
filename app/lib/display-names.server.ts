import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { profiles } from "./db/schema";
import { hitMemberLimit } from "./rate-limit.server";
import { getLocale } from "~/paraglide/runtime.js";
import { displayNamePresentation, type DisplayNames } from "./display-names";
export type { DisplayNames } from "./display-names";

export const DISPLAY_NAME_MAX = 50;

// Reject before trimming, including line separators and invisible direction controls.
export function parseDisplayNames(native: unknown, latin: unknown): DisplayNames | null {
  const clean = (raw: unknown, latinOnly: boolean): string | null | false => {
    if (typeof raw !== "string" || /[@＠﹫\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}\u3164\u2800]/u.test(raw) || /(?![\u200c\u200d])[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(raw)) return false;
    const value = raw.trim().normalize("NFC");
    if ([...value].length > DISPLAY_NAME_MAX) return false;
    if (value && (!/\p{L}/u.test(value) || /(?<!\p{L}\p{M}*)[\u200c\u200d]|[\u200c\u200d](?!\p{M}*\p{L})/u.test(value))) return false;
    if (latinOnly && value && !/^(?:\p{Script=Latin}\p{M}*|[ .\-\u2010\u2011'\u2019\u00b7])+$/u.test(value)) return false;
    return value || null;
  };
  const displayName = clean(native, false), displayNameLatin = clean(latin, true);
  return displayName === false || displayNameLatin === false ? null : { displayName, displayNameLatin };
}

// Resolve on the server so reading screens receive values without loading the selection rules.
export function selectDisplayNamePresentation(names: Parameters<typeof displayNamePresentation>[0], locale: string = getLocale()) {
  return displayNamePresentation(names, locale);
}

export function selectDisplayName(names: Parameters<typeof displayNamePresentation>[0], locale: string = getLocale()): string | null {
  return selectDisplayNamePresentation(names, locale).name;
}

export async function loadDisplayNames(db: Db, handles: readonly (string | null)[]) {
  const keys = [...new Set(handles.filter((handle): handle is string => !!handle))];
  const rows = keys.length ? await db.select({ handle: profiles.handle, homeArea: profiles.homeArea, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin })
    .from(profiles).where(inArray(profiles.handle, keys)) : [];
  return new Map(rows.map(row => [row.handle, row]));
}

// Machine readers always receive both forms, including explicit nulls.
export function displayNameFields(names: Partial<DisplayNames> | undefined) {
  return { display_name: names?.displayName ?? null, display_name_latin: names?.displayNameLatin ?? null };
}

export function displayNamesVersion(names: DisplayNames): string {
  return createHash("sha256").update(JSON.stringify([names.displayName, names.displayNameLatin])).digest("hex");
}

export async function updateDisplayNames(db: Db, userId: string, native: unknown, latin: unknown, opts: { now?: Date } = {}) {
  const names = parseDisplayNames(native, latin);
  if (!names) return { ok: false as const, error: "invalid_display_name" as const };
  return db.transaction(async tx => {
    const [current] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!current) return { ok: false as const, error: "not_found" as const };
    if (current.displayName === names.displayName && current.displayNameLatin === names.displayNameLatin) return { ok: true as const };
    const rate = await hitMemberLimit(tx, "display-name", userId, opts.now);
    if (!rate.allowed) return { ok: false as const, error: "rate_limited" as const };
    await tx.update(profiles).set({ ...names, displayNameActionId: null }).where(eq(profiles.userId, userId));
    return { ok: true as const };
  });
}
