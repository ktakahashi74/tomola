import { ensurePersonalVillage } from "./personal-villages.server";
import { isDeletedIdentity } from "./deleted-member";
import { trialParticipationRequired } from "~/lib/notice-sources.server";
import { trialConsentValues } from "~/lib/trial-consent.server";
import { validateTrialInput } from "~/lib/trial-consent.server";
import type { TrialInput, TrialError } from "~/lib/trial-consent";
import { eq, lte, sql } from "drizzle-orm";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { enrollInVillage, languageVillage } from "~/lib/villages.server";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { profiles, handleHolds, user } from "~/lib/db/schema";
import { handleKey, isReservedHandle } from "~/lib/handles";
import { defaultUiLocale, enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { AREAS, defaultLangOf, isArea, isLang, LANGS, type Area, type Lang } from "~/lib/languages";
import { isReason, type ReportReason } from "~/lib/moderation";
import { DEFAULT_EMAIL_PREF, isEmailPref, type EmailPref } from "~/lib/notifications";
import { rewriteStanceAreas } from "~/lib/stances.server";
import { HOME_AREA_CHANGE_DAYS } from "~/lib/profile-settings";
import { enrollFromSignupInvitation, lockSignupInvitationOwner } from "~/lib/signup-village.server";

const handleSchema = z.string().trim().transform(s => s.normalize("NFKC").toLowerCase()).pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,29}$/));

export const HANDLE_CHANGE_DAYS = 90;
const HANDLE_CHANGE_MS = HANDLE_CHANGE_DAYS * 24 * 60 * 60 * 1000;
export function nextHandleChangeAt(profile: Pick<Profile, "handleChangedAt">): Date | null {
  return profile.handleChangedAt === null ? null : new Date(profile.handleChangedAt.getTime() + HANDLE_CHANGE_MS);
}

// Serialize claims across profiles and holds, including a name with no current row.
export async function lockHandleNamespace(tx: Db, now: Date): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(2026100301)`);
  await tx.delete(handleHolds).where(lte(handleHolds.heldUntil, now));
}

export async function changeHandle(db: Db, userId: string, input: unknown, opts: { now?: Date } = {}): Promise<{ ok: true; changed: boolean } | { ok: false; error: "invalid_handle" | "handle_reserved" | "handle_taken" | "not_found" } | { ok: false; error: "too_soon"; nextChangeAt: Date }> {
  const parsed = handleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_handle" };
  if (isReservedHandle(parsed.data)) return { ok: false, error: "handle_reserved" };
  const now = opts.now ?? new Date();
  try {
    return await db.transaction(async tx => {
      await lockHandleNamespace(tx, now);
      const [row] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
      if (!row) return { ok: false as const, error: "not_found" as const };
      if (row.handle === parsed.data) return { ok: true as const, changed: false };
      const key = handleKey(parsed.data);
      const [hold] = await tx.select().from(handleHolds).where(eq(handleHolds.handleKey, key));
      if (hold && hold.userId !== userId) return { ok: false as const, error: "handle_taken" as const };
      const [taken] = await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.handleKey, key));
      if (taken) return { ok: false as const, error: "handle_taken" as const };
      const nextChangeAt = nextHandleChangeAt({ handleChangedAt: row.handleChangedAt });
      // An active own hold is a return, preserving the deadline of the last ordinary rename.
      const returning = hold?.userId === userId;
      if (!returning && nextChangeAt !== null && now < nextChangeAt) return { ok: false as const, error: "too_soon" as const, nextChangeAt };
      if (hold) await tx.delete(handleHolds).where(eq(handleHolds.handleKey, key));
      await tx.insert(handleHolds).values({ handleKey: row.handleKey, userId, heldUntil: new Date(now.getTime() + HANDLE_CHANGE_MS) }).onConflictDoUpdate({ target: handleHolds.handleKey, set: { userId, heldUntil: new Date(now.getTime() + HANDLE_CHANGE_MS) } });
      await tx.update(profiles).set({ handle: parsed.data, handleKey: key, ...(returning ? {} : { handleChangedAt: now }) }).where(eq(profiles.userId, userId));
      return { ok: true as const, changed: true };
    });
  } catch (error) { if (isHandleTakenViolation(error)) return { ok: false, error: "handle_taken" }; throw error; }
}
const langsSchema = z
  .array(z.enum(LANGS))
  .transform((langs) => [...new Set(langs)]);

// The signup input: a handle and the main language (homeArea; the column and its values are unchanged, only the wording is "main language").
// homeArea is checked against the enabled languages (or "other") inside createProfile (invalid_area). readLangs is optional: the default is the main language
// (defaultReadLangs); the signup screen does not send it, tests and seed data do. It must name enabled languages only (invalid_langs). There is no "writable languages" any more
// the language of a post is chosen per post, defaulting to the main language (defaultPostLang).
export const profileInputSchema = z.object({
  handle: handleSchema,
  homeArea: z.enum(AREAS),
  readLangs: langsSchema.optional(),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;
export type Profile = {
  userId: string;
  handle: string;
  displayName?: string | null;
  displayNameLatin?: string | null;
  handleChangedAt: Date | null;
  homeArea: Area;
  // Last membership-area change timestamp; null if unchanged since registration.
  homeAreaChangedAt: Date | null;
  readLangs: Lang[];
  // The language of shown translations (content, not the interface language). null: the interface language, then the first enabled original-reading language (resolveDisplayLang in app/lib/display.ts).
  displayLang: Lang | null;
  // Generation for 「AIで開く」 signed links (open-in-ai.server.ts).
  openInAiGeneration: number;
  // Suspension expiry; no writes until then, automatically inactive after expiry. Null without suspension record. getWriter in members.server.ts decides.
  suspendedUntil: Date | null;
  suspendedReason: ReportReason | null;
  // moderation_actions.id that caused this suspension.
  suspendedActionId: number | null;
  // Time stances/Insightful (「なるほど」) were excluded by operator exclude_reactions, null if not excluded. Action id checks whether exclusion still applies after a successful appeal.
  reactionsExcludedAt: Date | null;
  reactionsExcludedActionId: number | null;
  // Notification-mail preference, default daily.
  emailPref: EmailPref;
  // Last interface locale, used for mail language, or null if absent.
  uiLocale: string | null;
  signPosts: boolean;
  residenceCountry: string | null;
  adultConfirmedAt: Date | null;
  trialConsentVersion: number | null;
  trialConsentAt: Date | null;
  stanceConsentVersion: number | null;
  stanceConsentAt: Date | null;
  introEntryId?: number | null;
};

type CreateProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: "invalid_handle" | "handle_reserved" | "invalid_langs" | "invalid_area" | "handle_taken" | TrialError };

function toProfile(row: typeof profiles.$inferSelect): Profile {
  return {
    userId: row.userId,
    handle: row.handle,
    displayName: row.displayName,
    displayNameLatin: row.displayNameLatin,
    handleChangedAt: row.handleChangedAt,
    homeArea: row.homeArea as Area,
    homeAreaChangedAt: row.homeAreaChangedAt,
    readLangs: row.readLangs as Lang[],
    displayLang: isLang(row.displayLang) ? row.displayLang : null,
    openInAiGeneration: row.openInAiGeneration,
    suspendedUntil: row.suspendedUntil,
    suspendedReason: isReason(row.suspendedReason) ? row.suspendedReason : null,
    suspendedActionId: row.suspendedActionId,
    reactionsExcludedAt: row.reactionsExcludedAt,
    reactionsExcludedActionId: row.reactionsExcludedActionId,
    emailPref: isEmailPref(row.emailPref) ? row.emailPref : DEFAULT_EMAIL_PREF,
    uiLocale: row.uiLocale,
    signPosts: row.signPosts,
    residenceCountry: row.residenceCountry,
    adultConfirmedAt: row.adultConfirmedAt,
    trialConsentVersion: row.trialConsentVersion,
    trialConsentAt: row.trialConsentAt,
    stanceConsentVersion: row.stanceConsentVersion,
    stanceConsentAt: row.stanceConsentAt,
    introEntryId: row.introEntryId,
  };
}

export async function getProfile(db: Db, userId: string): Promise<Profile | null> {
  const [row] = await db.select({ profile: profiles, email: user.email }).from(profiles).innerJoin(user, eq(user.id, profiles.userId)).where(eq(profiles.userId, userId)).limit(1);
  return row && !isDeletedIdentity(userId, row.email) ? toProfile(row.profile) : null;
}

// Save notification-mail preference: immediate | daily | none.
export async function setEmailPref(db: Db, userId: string, pref: unknown): Promise<{ ok: true } | { ok: false; error: "invalid_pref" | "not_found" }> {
  if (!isEmailPref(pref)) return { ok: false, error: "invalid_pref" };
  const rows = await db.update(profiles).set({ emailPref: pref }).where(eq(profiles.userId, userId)).returning({ userId: profiles.userId });
  return rows.length > 0 ? { ok: true } : { ok: false, error: "not_found" };
}

// Remember interface locale for recipient-language mail; write only if changed.
export async function rememberUiLocale(db: Db, userId: string, current: string | null, locale: string): Promise<void> {
  if (current === locale) return;
  await db.update(profiles).set({ uiLocale: locale }).where(eq(profiles.userId, userId));
}

// Save display language; null restores the interface-language default.
export async function setDisplayLang(db: Db, userId: string, lang: Lang | null): Promise<void> {
  await db.update(profiles).set({ displayLang: lang }).where(eq(profiles.userId, userId));
}

// The default read languages: the main language only. For "other", the language of the signup screen (uiLocale, if it is an enabled language), otherwise defaultUiLocale().
export function defaultReadLangs(homeArea: Area, uiLocale?: Lang): Lang[] {
  if (homeArea !== "other") return [homeArea];
  return [uiLocale && isEnabledLang(uiLocale) ? uiLocale : defaultUiLocale()];
}

// The default language of a post: the main language if it is an enabled language; for "other" or a language that is not enabled, the first enabled language the member
// reads, otherwise the default of the enabled languages. The language is chosen per post from the enabled languages (signup does not ask for "writable languages").
export function defaultPostLang(profile: Pick<Profile, "homeArea" | "readLangs">, enabled: readonly Lang[] = enabledLangs()): Lang {
  if (profile.homeArea !== "other" && enabled.includes(profile.homeArea)) return profile.homeArea;
  return profile.readLangs.find((l) => enabled.includes(l)) ?? defaultLangOf(enabled);
}

// opts.uiLocale: the default read language when the main language is "other" (the language of the signup screen).
export async function createProfile(db: Db, userId: string, input: unknown, opts: { uiLocale?: Lang; now?: Date; trial?: TrialInput } = {}): Promise<CreateProfileResult> {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (isDeletedIdentity(userId, account?.email)) return { ok: false, error: "handle_reserved" };
  const parsed = profileInputSchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "handle") return { ok: false, error: "invalid_handle" };
    if (field === "homeArea") return { ok: false, error: "invalid_area" };
    return { ok: false, error: "invalid_langs" };
  }
  const data = parsed.data;
  if (isReservedHandle(data.handle)) return { ok: false, error: "handle_reserved" };
  // The main language is an enabled language or "other"; read languages are enabled languages only.
  if (!isSelectableArea(data.homeArea)) return { ok: false, error: "invalid_area" };
  if (data.readLangs && !data.readLangs.every((l) => isEnabledLang(l))) return { ok: false, error: "invalid_langs" };
  const readLangs = data.readLangs ?? defaultReadLangs(data.homeArea, opts.uiLocale);
  const trial = trialParticipationRequired() ? opts.trial : undefined;
  if (trial) { const error = validateTrialInput(trial); if (error) return { ok: false, error }; }
  const key = handleKey(data.handle);
  const now = opts.now ?? new Date();
  try {
    return await db.transaction(async tx => {
      await lockHandleNamespace(tx, now);
      const [taken] = await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.handleKey, key));
      if (taken) return { ok: false as const, error: "handle_taken" as const };
      const [hold] = await tx.select().from(handleHolds).where(eq(handleHolds.handleKey, key));
      if (hold && hold.userId !== userId) return { ok: false as const, error: "handle_taken" as const };
      if (hold) await tx.delete(handleHolds).where(eq(handleHolds.handleKey, key));
      const signupInvitation = await lockSignupInvitationOwner(tx, userId);
      const [row] = await tx.insert(profiles).values({ ...(trial ? trialConsentValues(trial, now) : {}), userId, handle: data.handle, handleKey: key, homeArea: data.homeArea, readLangs }).returning();
      const personal = await ensurePersonalVillage(tx, userId);
      await tx.update(profiles).set({ defaultVillageId: personal.id }).where(eq(profiles.userId, userId));
      if (villagesEnabled() && data.homeArea !== "other") {
        const village = await languageVillage(tx, data.homeArea);
        if (village) await enrollInVillage(tx, userId, village.id);
      }
      await enrollFromSignupInvitation(tx, userId, signupInvitation);
      return { ok: true as const, profile: toProfile(row) };
    });
  } catch (err) {
    if (isHandleTakenViolation(err)) return { ok: false, error: "handle_taken" };
    throw err;
  }
}

// The values that can be chosen as the main language: the enabled languages (ENABLED_LANGS) and "other".
export function isSelectableArea(area: unknown): area is Area {
  return isArea(area) && (area === "other" || isEnabledLang(area));
}

// Changes of the read languages and the display language (/settings). The read languages may be empty, otherwise enabled languages only (invalid_langs). Values that are saved now but are
// not enabled are kept (closing a language must not erase a member's setting): they are appended to the submitted read languages. The display language is an enabled language or empty
// (null: the interface-language default).
export type PreferencesError = "invalid_langs" | "invalid_display_lang" | "not_found";
export async function updatePreferences(
  db: Db,
  userId: string,
  input: { readLangs?: unknown; displayLang?: unknown },
): Promise<{ ok: true } | { ok: false; error: PreferencesError }> {
  const read = langsSchema.safeParse("readLangs" in input ? input.readLangs : []);
  if (!read.success || !read.data.every((l) => isEnabledLang(l))) return { ok: false, error: "invalid_langs" };
  const displayLang = input.displayLang === null || input.displayLang === "" ? null : isEnabledLang(input.displayLang) ? input.displayLang : undefined;
  if ("displayLang" in input && displayLang === undefined) return { ok: false, error: "invalid_display_lang" };
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ readLangs: profiles.readLangs }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!row) return { ok: false as const, error: "not_found" as const };
    const kept = (row.readLangs as string[]).filter((l) => isLang(l) && !isEnabledLang(l));
    await tx.update(profiles).set({
      ...("readLangs" in input ? { readLangs: [...read.data, ...kept] } : {}),
      ...("displayLang" in input ? { displayLang } : {}),
    }).where(eq(profiles.userId, userId));
    return { ok: true as const };
  });
}

// Membership-area changes: first change anytime after registration to correct an initial choice. Subsequent changes require
// at least 90 days since the previous change.
export { HOME_AREA_CHANGE_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;

// Next allowed area-change time, inclusive; null before the first change, meaning anytime.
export function nextHomeAreaChangeAt(profile: Pick<Profile, "homeAreaChangedAt">): Date | null {
  if (profile.homeAreaChangedAt === null) return null;
  return new Date(profile.homeAreaChangedAt.getTime() + HOME_AREA_CHANGE_DAYS * DAY_MS);
}

export type HomeAreaError = "invalid_area" | "too_soon" | "not_found";

// Change area: first anytime, then at least 90 days between changes. Choosing the same area is a no-op,
// preserving first-change eligibility/deadline. Past votes' voter_area remains the posting-time membership area.
// Update current stances.area to the new area in the same transaction. Historical stance_changes.area remains its change-time snapshot.
// Read/update under one row-locked transaction so concurrent changes cannot bypass deadlines. All stance changes lock this profile first.
export async function changeHomeArea(
  db: Db,
  userId: string,
  area: unknown,
  opts: { now?: Date } = {},
): Promise<{ ok: true; changed: boolean } | { ok: false; error: "invalid_area" | "not_found" } | { ok: false; error: "too_soon"; nextChangeAt: Date }> {
  // An enabled language or "other" only (ENABLED_LANGS).
  if (!isSelectableArea(area)) return { ok: false, error: "invalid_area" };
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!row) return { ok: false as const, error: "not_found" as const };
    if (row.homeArea === area) return { ok: true as const, changed: false };
    const nextChangeAt = nextHomeAreaChangeAt(toProfile(row));
    if (nextChangeAt !== null && now < nextChangeAt) return { ok: false as const, error: "too_soon" as const, nextChangeAt };
    await tx.update(profiles).set({ homeArea: area, homeAreaChangedAt: now }).where(eq(profiles.userId, userId));
    await rewriteStanceAreas(tx, userId, area);
    return { ok: true as const, changed: true };
  });
}

// Names of the unique constraint on profiles.handle (drizzle-kit generated it from `handle: text("handle").notNull().unique()`
// in schema.ts, "<table>_<column>_unique") and of the unique index on profiles.handle_key (handleKey in schema.ts). Renaming either
// in schema.ts requires updating these.
const HANDLE_UNIQUE_CONSTRAINTS = ["profiles_handle_unique", "profiles_handle_key_unique"];

// Only the handle uniqueness maps to handle_taken; other unique violations (e.g. the primary key
// when the user already has a profile) must surface as errors. Drizzle wraps the driver error in
// `cause`, which carries `code` and `constraint`.
function isHandleTakenViolation(err: unknown): boolean {
  const field = (e: unknown, key: string) =>
    typeof e === "object" && e !== null && key in e ? (e as Record<string, unknown>)[key] : undefined;
  return [err, field(err, "cause")].some(
    (e) => field(e, "code") === "23505" && HANDLE_UNIQUE_CONSTRAINTS.includes(String(field(e, "constraint"))),
  );
}

// The caller owns the namespace and member locks before reserving these names.
export async function reserveDepartingHandles(tx: Db, userId: string, currentKey: string, now: Date) {
  const heldUntil = new Date(now.getTime() + HANDLE_CHANGE_MS);
  await tx.update(handleHolds).set({ userId: null, heldUntil: sql`greatest(${handleHolds.heldUntil}, ${heldUntil})` }).where(eq(handleHolds.userId, userId));
  await tx.insert(handleHolds).values({ handleKey: currentKey, userId: null, heldUntil }).onConflictDoUpdate({ target: handleHolds.handleKey, set: { userId: null, heldUntil } });
}
