import { memberAvatarUrl } from "./member-avatar.server";
import { selectDisplayNamePresentation } from "./display-names.server";
import { personalVillage } from "./personal-villages.server";
import { publicVillage } from "./villages.server";
import { isFollowingVillage } from "./village-follows.server";
import { localizeVillages } from "./village-translations.server";
import type { PublicVillage } from "./villages.server";
import { publicTopicPlace } from "~/lib/visibility.server";
import { safeErrorText } from "~/lib/error-text.server";
import { withMarkdownRead } from "./markdown-budget.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, handleHolds, profiles, translations, villages } from "~/lib/db/schema";
import { renderEntryHtml } from "~/lib/entries.server";
import { loadEntryDisplays, loadTitleDisplays, type EntryDisplay, type TitleDisplay } from "~/lib/entry-display.server";
import { headlineFromBody } from "~/lib/headline.server";
import type { Lang } from "~/lib/languages";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { resolveSavedMentionsFor } from "~/lib/mentions.server";
import { saveRenderedEntry } from "~/lib/render-cache.server";

// Internal identity only: callers must return MemberPageContent to the browser.
export type MemberPageIdentity = { userId: string; handle: string; publicId?: string; avatarMediaId?: string | null; introEntryId: number | null; displayName?: string | null; displayNameLatin?: string | null; homeArea?: string; redirectTo?: string };
const memberColumns = { publicId: profiles.publicId, avatarMediaId: profiles.avatarMediaId, userId: profiles.userId, handle: profiles.handle, introEntryId: profiles.introEntryId, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea };

export async function resolveMemberPage(db: Db, handle: string, opts: { now?: Date } = {}): Promise<MemberPageIdentity | null> {
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(handle)) return null;
  const [current] = await db.select(memberColumns).from(profiles).where(eq(profiles.handle, handle));
  if (current) return current;
  const [held] = await db.select(memberColumns).from(handleHolds)
    .innerJoin(profiles, eq(profiles.userId, handleHolds.userId))
    .where(and(eq(handleHolds.handleKey, handle), gt(handleHolds.heldUntil, opts.now ?? new Date())));
  return held ? { ...held, redirectTo: `/u/${held.handle}` } : null;
}

export type MemberPageContent = {
  name: string | null;
  nameLatin: string | null;
  hasDisplayName: boolean;
  avatarUrl: string | null;
  hasUploadedAvatar: boolean;
  handle: string;
  own: boolean;
  intro: null | { id: number; lang: Lang; title: string | null; headline: string; html: string; display: EntryDisplay };
  topics: { id: number; lang: Lang; title: TitleDisplay; createdAtISO: string; village?: PublicVillage; readLanguageCount?: number }[];
  personal: null | { following: boolean; topics: MemberPageContent["topics"]; page: number; hasNext: boolean };
  page: number;
  hasNext: boolean;
};
export type MemberPageOptions = {
  viewerId: string;
  readLangs: readonly Lang[];
  displayLang: Lang;
  page: number;
  personalPage?: number;
  forceOriginal?: ReadonlySet<number>;
  forceTranslation?: ReadonlySet<number>;
  forceOlder?: ReadonlySet<number>;
};
const PAGE_SIZE = 20;
const pageNumber = (value = 1) => Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger((value - 1) * PAGE_SIZE) ? value : 1;

export async function loadMemberPageContent(db: Db, member: MemberPageIdentity, opts: MemberPageOptions): Promise<MemberPageContent> {
  const page = pageNumber(opts.page);
  const personalPage = pageNumber(opts.personalPage);
  // Dedicated projection: no reaction counts, distributions or viewer stances are loaded.
  const personal = villagesEnabled() ? await personalVillage(db, member.userId) : null;
  const condition = and(eq(entries.authorId, member.userId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace());
  const readRows = (own: boolean, page: number) => db.select({ id: entries.id, lang: entries.lang, title: entries.title, body: entries.body, sourceHash: entries.sourceHash, createdAt: entries.createdAt, village: villages })
    .from(entries).leftJoin(villages, eq(villages.id, entries.villageId))
    .where(and(condition, personal ? own ? eq(entries.villageId, personal.id) : or(isNull(entries.villageId), ne(entries.villageId, personal.id)) : undefined))
    .orderBy(desc(entries.createdAt), desc(entries.id)).limit(PAGE_SIZE + 1).offset((page - 1) * PAGE_SIZE);
  const [rows, personalRows] = await Promise.all([readRows(false, page), personal ? readRows(true, personalPage) : Promise.resolve([])]);
  const visible = rows.slice(0, PAGE_SIZE).map(row => ({ ...row, lang: row.lang as Lang }));
  const personalVisible = personalRows.slice(0, PAGE_SIZE).map(row => ({ ...row, lang: row.lang as Lang }));
  const titles = await loadTitleDisplays(db, [...visible, ...personalVisible], opts, true);
  const own = opts.viewerId === member.userId;
  const visibleIds = [...visible, ...personalVisible].map(row => row.id);
  // Query only this owner's visible sections. Other viewers receive no reading data.
  const readCounts = own && visibleIds.length ? await db.select({ entryId: translations.entryId, count: sql<number>`count(distinct ${translations.lang})::int` })
    .from(translations).innerJoin(entries, eq(entries.id, translations.entryId))
    .where(and(inArray(translations.entryId, visibleIds), eq(translations.field, "body"), eq(translations.everSeen, true), ne(translations.lang, entries.lang)))
    .groupBy(translations.entryId) : [];
  const readCountById = new Map(readCounts.map(row => [row.entryId, row.count]));
  const places = villagesEnabled() ? await localizeVillages(db, visible.flatMap(row => row.village ? [publicVillage(row.village)] : []), opts) : [];
  const contentRow = (row: typeof visible[number], elsewhere: boolean) => ({ id: row.id, lang: row.lang, title: titles.get(row.id)!, createdAtISO: row.createdAt.toISOString(), ...(readCountById.has(row.id) ? { readLanguageCount: readCountById.get(row.id)! } : {}), ...(elsewhere && row.village ? { village: places.find(place => place.slug === row.village?.slug) } : {}) });
  let intro: MemberPageContent["intro"] = null;
  if (member.introEntryId !== null) {
    const [row] = await db.select({ id: entries.id, lang: entries.lang, title: entries.title, body: entries.body, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, html: entries.html, htmlVersion: entries.htmlVersion })
      .from(entries).where(and(eq(entries.id, member.introEntryId), eq(entries.authorId, member.userId), eq(entries.kind, "topic"), eq(entries.asksStance, false), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
    if (row) {
      let html = row.html;
      if (html === null || row.htmlVersion !== RENDER_VERSION) {
        const saved = await resolveSavedMentionsFor(db, [row]);
        const mentions = saved.get(row.id) ?? new Map();
        const rendered = (await withMarkdownRead(() => renderEntryHtml("topic", row.id, row.body, row.lang, mentions)));
        html = rendered.html;
        try {
          await saveRenderedEntry(db, row.id, row.body, rendered, row.sourceHash, row.mentionRevision);
        } catch (error) {
          console.warn(`[member-pages] could not cache introduction ${row.id}:`, safeErrorText(error));
        }
      }
      const displays = await loadEntryDisplays(db, [{ id: row.id, kind: "topic", lang: row.lang as Lang, sourceHash: row.sourceHash }], { ...opts, variant: "full" });
      intro = { id: row.id, lang: row.lang as Lang, title: row.title, headline: (await headlineFromBody(row.body)), html, display: displays.get(row.id)! };
    }
  }
  const displayName = selectDisplayNamePresentation(member);
  return {
    avatarUrl: memberAvatarUrl(member),
    hasUploadedAvatar: !!member.avatarMediaId,
    handle: member.handle,
    name: displayName.name,
    nameLatin: displayName.latin,
    hasDisplayName: !!(member.displayName || member.displayNameLatin),
    own,
    intro,
    topics: visible.map(row => contentRow(row, true)),
    personal: personal ? { following: await isFollowingVillage(db, opts.viewerId, personal.id), topics: personalVisible.map(row => contentRow(row, false)), page: personalPage, hasNext: personalRows.length > PAGE_SIZE } : null,
    page,
    hasNext: rows.length > PAGE_SIZE,
  };
}

export type IntroductionResult = { ok: true } | { ok: false; error: "not_found" | "forbidden" | "invalid_intro" };
export async function setIntroduction(db: Db, userId: string, entryId: number | null): Promise<IntroductionResult> {
  return db.transaction(async tx => {
    // Village posting locks the profile before referenced topics. Use the same order here.
    if (villagesEnabled()) {
      const [member] = await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
      if (!member) return { ok: false as const, error: "not_found" as const };
    }
    if (entryId !== null) {
      if (!Number.isSafeInteger(entryId) || entryId < 1) return { ok: false as const, error: "not_found" as const };
      // Lock the entry so concurrent hiding/deletion cannot invalidate this designation.
      const [entry] = await tx.select({ authorId: entries.authorId, kind: entries.kind, asksStance: entries.asksStance, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt })
        .from(entries).where(and(eq(entries.id, entryId), publicTopicPlace())).for("no key update");
      if (!entry) return { ok: false as const, error: "not_found" as const };
      if (entry.authorId !== userId) return { ok: false as const, error: "forbidden" as const };
      if (entry.kind !== "topic" || entry.asksStance || entry.hiddenAt !== null || entry.deletedAt !== null) return { ok: false as const, error: "invalid_intro" as const };
    }
    const changed = await tx.update(profiles).set({ introEntryId: entryId }).where(eq(profiles.userId, userId)).returning({ userId: profiles.userId });
    return changed.length ? { ok: true as const } : { ok: false as const, error: "not_found" as const };
  });
}

// Clear only the introduction selected on this topic; a stale page cannot clear a newer choice.
export async function unsetIntroduction(db: Db, userId: string, entryId: number): Promise<IntroductionResult> {
  return db.transaction(async tx => {
    const [current] = await tx.select({ introEntryId: profiles.introEntryId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (current?.introEntryId !== entryId) return { ok: false as const, error: "forbidden" as const };
    return setIntroduction(tx, userId, null);
  });
}
