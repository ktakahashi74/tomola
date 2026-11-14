import { chatNushiEnabled } from "./chat-nushi-config.server";
import { recordTranslationGeneration } from "./eval/signals.server";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, not, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatConsents, chatMessages, chatMessageTranslations, jobs, profiles, villageMembers, villages } from "./db/schema";
import { resolveDisplayLang } from "./display";
import { enabledLangs, isEnabledLang } from "./enabled-langs.server";
import { isLang, type Lang } from "./languages";
import type { ChatTranslation } from "./village-chat";
import { CHAT_TRANSLATION_CONTEXT_COUNT } from "./village-chat";
import { CHAT_CONSENT_VERSION } from "./village-chat-consent";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { signalVillageChat } from "./village-chat-events.server";
import { nextChatSequence } from "./village-chat-sequence.server";
import { chatVillageCondition } from "./village-chat-villages.server";
import { enqueue } from "./jobs/queue.server";
import { discardPaidTranslationCalls } from "./jobs/paid-translation.server";

type Message = typeof chatMessages.$inferSelect;
type Reader = Pick<typeof profiles.$inferSelect, "displayLang" | "readLangs" | "uiLocale">;
export type ChatTranslationPayload = { messageId: string; lang: Lang; sourceHash: string };
export const chatSourceHash = (text: string) => createHash("sha256").update(text).digest("hex");
// In addition to the first job, allow at most three replacements after crashes.
const MAX_CHAT_JOB_RECREATIONS = 3;
const chatJobKey = (messageId: string, lang: Lang, sourceHash: string) => `translate-chat:${messageId}:${lang}:${sourceHash}`;

export function neededChatLanguage(messageLang: string, profile: Reader): Lang | null {
  const lang = resolveDisplayLang({ profile: { displayLang: isLang(profile.displayLang) ? profile.displayLang : null, readLangs: profile.readLangs.filter(isLang) }, uiLocale: profile.uiLocale, enabled: enabledLangs() });
  return messageLang === lang || profile.readLangs.includes(messageLang) || !isEnabledLang(lang) ? null : lang;
}

// Caller holds a message lock, or has just inserted it. Only an exclusive
// holder may apply the cap. Return whether the cap changed its state;
// callers allocate the message cursor after all existing-row locks are held.
// Keep bodies out of jobs; the unfinished-job key deduplicates shared readers.
async function requestTranslation(db: Db, message: Message, lang: Lang, exclusive: boolean): Promise<boolean> {
  if (!isEnabledLang(lang) || message.deletedAt || message.hiddenAt) return false;
  const sourceHash = chatSourceHash(message.body);
  const [existing] = await db.select().from(chatMessageTranslations).where(and(eq(chatMessageTranslations.messageId, message.id), eq(chatMessageTranslations.lang, lang)));
  const dedupeKey = chatJobKey(message.id, lang, sourceHash);
  if (existing?.sourceHash === sourceHash) {
    if (existing.state !== "pending" && existing.state !== "paused") return false;
    const [live] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.dedupeKey, dedupeKey), inArray(jobs.status, ["queued", "running"])));
    if (live) return false;
  }
  const failed = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, "translate_chat"), eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, "failed"))).limit(MAX_CHAT_JOB_RECREATIONS + 1);
  const exhausted = exclusive && failed.length > MAX_CHAT_JOB_RECREATIONS;
  if (existing?.sourceHash === sourceHash) {
    if (exhausted) {
      const changed = await db.update(chatMessageTranslations).set({ state: "failed", text: null, errorCode: "recovery_limit", updatedAt: new Date() })
        .where(and(eq(chatMessageTranslations.messageId, message.id), eq(chatMessageTranslations.lang, lang), eq(chatMessageTranslations.sourceHash, sourceHash), inArray(chatMessageTranslations.state, ["pending", "paused"]))).returning({ id: chatMessageTranslations.messageId });
      return changed.length > 0;
    }
    await enqueue(db, "translate_chat", { messageId: message.id, lang, sourceHash }, { dedupeKey, maxAttempts: 5 });
    return false;
  }
  if (existing) {
    // Another reader can renew this row while we wait. Never delete its new
    // source version or cancel its newly queued work.
    await db.delete(chatMessageTranslations).where(and(eq(chatMessageTranslations.messageId, message.id), eq(chatMessageTranslations.lang, lang), eq(chatMessageTranslations.sourceHash, existing.sourceHash)));
    await db.delete(jobs).where(and(eq(jobs.kind, "translate_chat"), eq(jobs.status, "queued"),
      eq(sql`${jobs.payload}->>'messageId'`, message.id), eq(sql`${jobs.payload}->>'lang'`, lang), eq(sql`${jobs.payload}->>'sourceHash'`, existing.sourceHash)));
  }
  const [inserted] = await db.insert(chatMessageTranslations).values({ messageId: message.id, lang, sourceHash, ...(exhausted ? { state: "failed", errorCode: "recovery_limit" } : {}) })
    .onConflictDoNothing().returning({ id: chatMessageTranslations.messageId });
  if (inserted && !exhausted) await enqueue(db, "translate_chat", { messageId: message.id, lang, sourceHash }, { dedupeKey, maxAttempts: 5 });
  return !!inserted && exhausted;
}

// Sending and editing enqueue in the message transaction, before its final
// sequence allocation. Only current, consenting readers determine targets.
export async function enqueueChatTranslations(db: Db, message: Message): Promise<void> {
  if (!villageChatEnabled()) return;
  const enabled = enabledLangs();
  const language = sql<string>`coalesce(
    case when ${inArray(profiles.displayLang, enabled)} then ${profiles.displayLang} end,
    case when ${inArray(profiles.uiLocale, enabled)} then ${profiles.uiLocale} end,
    (select r.lang from unnest(${profiles.readLangs}) with ordinality r(lang, n) where r.lang in (${sql.join(enabled.map(lang => sql`${lang}`), sql`, `)}) order by r.n limit 1),
    ${enabled.includes("en") ? "en" : enabled[0]})`;
  const readers = await db.selectDistinct({ lang: language }).from(villageMembers)
    .innerJoin(profiles, eq(profiles.userId, villageMembers.userId))
    .innerJoin(chatConsents, and(eq(chatConsents.villageId, villageMembers.villageId), eq(chatConsents.userId, villageMembers.userId), eq(chatConsents.version, CHAT_CONSENT_VERSION)))
    .where(and(eq(villageMembers.villageId, message.villageId), message.authorId ? ne(profiles.userId, message.authorId) : undefined,
      sql`not (${message.lang} = any(${profiles.readLangs}))`, ne(language, message.lang)));
  const langs = readers.map(row => row.lang).filter(isLang);
  for (const lang of langs) await requestTranslation(db, message, lang, true);
}

// Editing and all deletion paths invalidate translations and unstarted work.
// Running work validates the locked source again before saving.
export async function clearChatTranslations(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.delete(chatMessageTranslations).where(inArray(chatMessageTranslations.messageId, ids));
  const matching = and(eq(jobs.kind, "translate_chat"), inArray(sql`${jobs.payload}->>'messageId'`, ids))!;
  await discardPaidTranslationCalls(db, matching);
  await db.delete(jobs).where(and(matching, eq(jobs.status, "queued")));
}

// Page/query language overrides deliberately do not enter this function.
// Lock in the same order as writes, and use only the rows this reader requested.
export async function chatTranslationsFor(db: Db, villageId: string, userId: string, messages: Message[]): Promise<Map<string, ChatTranslation>> {
  const result = new Map<string, ChatTranslation>();
  if (!villageChatEnabled() || !messages.length) return result;
  let changedSeq: number | undefined;
  await db.transaction(async tx => {
    const [village] = await tx.select({ id: villages.id }).from(villages).where(and(eq(villages.id, villageId), chatVillageCondition())).for("share");
    if (!village) return;
    const [member] = await tx.select().from(villageMembers).where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, userId))).for("share");
    if (!member) return;
    const [reader] = await tx.select({ profile: profiles }).from(profiles).innerJoin(chatConsents, and(eq(chatConsents.userId, profiles.userId), eq(chatConsents.villageId, villageId), eq(chatConsents.version, CHAT_CONSENT_VERSION))).where(eq(profiles.userId, userId));
    if (!reader) return;
    const candidates = messages.filter(m => !m.deletedAt && !m.hiddenAt && (m.authorKind !== "nushi" || chatNushiEnabled()) && m.authorId !== userId)
      .flatMap(message => { const lang = neededChatLanguage(message.lang, reader.profile); return lang ? [{ message, lang, sourceHash: chatSourceHash(message.body) }] : []; });
    if (!candidates.length) return;
    const ids = candidates.map(candidate => candidate.message.id);
    const readRows = () => tx.select().from(chatMessageTranslations).where(and(inArray(chatMessageTranslations.messageId, ids), eq(chatMessageTranslations.lang, candidates[0].lang)));
    let rows = await readRows();
    const byMessage = new Map(rows.map(row => [row.messageId, row]));
    const unsettled = candidates.filter(({ message, sourceHash }) => {
      const row = byMessage.get(message.id);
      return row?.sourceHash === sourceHash && (row.state === "pending" || row.state === "paused");
    });
    const live = unsettled.length ? await tx.select({ key: jobs.dedupeKey }).from(jobs).where(and(eq(jobs.kind, "translate_chat"), inArray(jobs.status, ["queued", "running"]),
      inArray(jobs.dedupeKey, unsettled.map(c => chatJobKey(c.message.id, c.lang, c.sourceHash))))) : [];
    const liveKeys = new Set(live.map(row => row.key));
    const needed = candidates.filter(({ message, lang, sourceHash }) => {
      const row = byMessage.get(message.id);
      return !row || row.sourceHash !== sourceHash || ((row.state === "pending" || row.state === "paused") && !liveKeys.has(chatJobKey(message.id, lang, sourceHash)));
    });
    if (needed.length) {
      // Read established translations without source-row locks. Only missing,
      // stale or orphaned requests need to prevent concurrent source edits.
      const failures = await tx.select({ key: jobs.dedupeKey }).from(jobs).where(and(eq(jobs.kind, "translate_chat"), eq(jobs.status, "failed"),
        inArray(jobs.dedupeKey, needed.map(c => chatJobKey(c.message.id, c.lang, c.sourceHash)))));
      const failedKeys = new Set(failures.map(row => row.key));
      // Recovery may now change the cursor. Take its exclusive source lock
      // directly; upgrading shared locks would deadlock concurrent readers.
      const locked: Message[] = [];
      if (!failedKeys.size) locked.push(...await tx.select().from(chatMessages).where(and(eq(chatMessages.villageId, villageId), inArray(chatMessages.id, needed.map(c => c.message.id))))
        .orderBy(asc(chatMessages.id)).for("share"));
      else for (const candidate of [...needed].sort((a, b) => a.message.id.localeCompare(b.message.id))) {
        locked.push(...await tx.select().from(chatMessages).where(and(eq(chatMessages.villageId, villageId), eq(chatMessages.id, candidate.message.id)))
          .for(failedKeys.has(chatJobKey(candidate.message.id, candidate.lang, candidate.sourceHash)) ? "update" : "share"));
      }
      const snapshots = new Map(needed.map(c => [c.message.id, c]));
      const capped: string[] = [];
      for (const message of locked) {
        const snapshot = snapshots.get(message.id)!;
        if (message.body !== snapshot.message.body || message.lang !== snapshot.message.lang || message.deletedAt || message.hiddenAt) continue;
        const exclusive = failedKeys.has(chatJobKey(message.id, snapshot.lang, snapshot.sourceHash));
        if (await requestTranslation(tx, message, snapshot.lang, exclusive)) capped.push(message.id);
      }
      if (capped.length) {
        changedSeq = await nextChatSequence(tx, villageId, capped.length);
        for (let i = 0; i < capped.length; i++) await tx.update(chatMessages).set({ changedSeq: changedSeq - capped.length + i + 1 }).where(eq(chatMessages.id, capped[i]));
      }
      rows = await readRows();
    }
    const finalRows = new Map(rows.map(row => [row.messageId, row]));
    for (const { message, sourceHash } of candidates) {
      const row = finalRows.get(message.id);
      if (row?.sourceHash === sourceHash) result.set(message.id, { text: row.text, lang: row.lang, state: row.state, errorCode: row.errorCode });
    }
  });
  if (changedSeq !== undefined) signalVillageChat(villageId, changedSeq);
  return result;
}

export async function chatTranslationSettled(db: Db, payload: ChatTranslationPayload): Promise<boolean> {
  if (!villageChatEnabled() || !isEnabledLang(payload.lang)) return false;
  const [row] = await db.select({ state: chatMessageTranslations.state }).from(chatMessageTranslations).where(and(
    eq(chatMessageTranslations.messageId, payload.messageId), eq(chatMessageTranslations.lang, payload.lang), eq(chatMessageTranslations.sourceHash, payload.sourceHash),
    inArray(chatMessageTranslations.state, ["ready", "failed"])));
  return !!row;
}

export async function chatTranslationSource(db: Db, payload: ChatTranslationPayload) {
  if (!villageChatEnabled() || !isEnabledLang(payload.lang)) return null;
  const [message] = await db.select({ message: chatMessages }).from(chatMessages).innerJoin(villages, eq(villages.id, chatMessages.villageId))
    .where(and(eq(chatMessages.id, payload.messageId), chatVillageCondition(), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt)));
  if (!message || message.message.authorKind === "nushi" && !chatNushiEnabled() || chatSourceHash(message.message.body) !== payload.sourceHash) return null;
  const m = message.message;
  if (m.authorKind === "nushi") return { message: m, context: [] };
  const previous = await db.select({ id: chatMessages.id, body: chatMessages.body }).from(chatMessages).where(and(
    eq(chatMessages.villageId, m.villageId), eq(chatMessages.authorKind, "human"), lt(chatMessages.createdSeq, m.createdSeq),
    gte(chatMessages.createdAt, new Date(m.createdAt.getTime() - 10 * 60_000)),
    sql`${chatMessages.createdAt} <= ${m.createdAt}`, isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt),
  )).orderBy(desc(chatMessages.createdSeq)).limit(CHAT_TRANSLATION_CONTEXT_COUNT);
  const [parent] = m.replyToId ? await db.select({ id: chatMessages.id, body: chatMessages.body }).from(chatMessages).where(and(eq(chatMessages.id, m.replyToId), eq(chatMessages.villageId, m.villageId), eq(chatMessages.authorKind, "human"), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt))) : [];
  return { message: m, context: [...(parent && !previous.some(row => row.id === parent.id) ? [parent.body] : []), ...previous.reverse().map(row => row.body)] };
}

type SavedTranslation = Pick<typeof chatMessageTranslations.$inferInsert, "state" | "text" | "model" | "promptVersion" | "errorCode">;
export async function saveChatTranslation(db: Db, payload: ChatTranslationPayload, update: SavedTranslation, options: { preserveSettled?: boolean } = {}): Promise<boolean> {
  if (!villageChatEnabled() || !isEnabledLang(payload.lang)) return false;
  const saved = await db.transaction(async tx => {
    const [source] = await tx.select({ villageId: chatMessages.villageId }).from(chatMessages).where(eq(chatMessages.id, payload.messageId));
    if (!source) return null;
    const [village] = await tx.select({ id: villages.id }).from(villages).where(and(eq(villages.id, source.villageId), chatVillageCondition())).for("share");
    if (!village) return null;
    const [message] = await tx.select().from(chatMessages).where(eq(chatMessages.id, payload.messageId)).for("update");
    if (!message || message.deletedAt || message.hiddenAt || chatSourceHash(message.body) !== payload.sourceHash) return null;
    const [previous] = await tx.select().from(chatMessageTranslations).where(and(eq(chatMessageTranslations.messageId, message.id), eq(chatMessageTranslations.lang, payload.lang)));
    // A recovered worker must not replace output committed by an earlier run.
    if (options.preserveSettled && previous?.sourceHash === payload.sourceHash && (previous.state === "ready" || previous.state === "failed")) return null;
    if (update.state === "pending" && previous && (previous.sourceHash !== payload.sourceHash || previous.state !== "paused")) return null;
    if (previous?.sourceHash === payload.sourceHash && previous.state === update.state && previous.text === (update.text ?? null)) return null;
    const values = { ...update, text: update.text ?? null, updatedAt: new Date() };
    await tx.insert(chatMessageTranslations).values({ messageId: message.id, lang: payload.lang, sourceHash: payload.sourceHash, ...values })
      .onConflictDoUpdate({ target: [chatMessageTranslations.messageId, chatMessageTranslations.lang], set: { sourceHash: payload.sourceHash, ...values } });
    if (update.state === "ready" && update.model) await recordTranslationGeneration(tx, "chat", message.lang, payload.lang);
    const seq = await nextChatSequence(tx, village.id);
    await tx.update(chatMessages).set({ changedSeq: seq }).where(eq(chatMessages.id, message.id));
    return { villageId: village.id, seq };
  });
  if (saved) signalVillageChat(saved.villageId, saved.seq);
  return !!saved;
}
