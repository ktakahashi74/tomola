import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { invitationNoteTranslations, invitations, jobs } from "./db/schema";
import { isEnabledLang } from "./enabled-langs.server";
import { isLang, type Lang } from "./languages";
import { enqueue } from "./jobs/queue.server";
import { drainRetentionRows, type RetentionResults } from "./retention-batch.server";
import { daysBefore, RETENTION } from "./retention";
import { readPostTranslationWait } from "./translation-wait.server";

export const TRANSLATE_INVITATION_NOTE_JOB = "translate_invitation_note";
export type InvitationNotePayload = { invitationId: string; lang: Lang };
export const activeInvitation = (now: Date) => and(isNull(invitations.usedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now), isNotNull(invitations.email), isNotNull(invitations.createdBy), isNotNull(invitations.note));
export type InvitationNoteView = { text: string; from: Lang; lang: Lang; translated: boolean; available: boolean; pending: boolean; unavailable: boolean };

// Only a valid invitation can request work. Lock it before inserting the cache row,
// so retention cannot remove a note and then have its work recreated.
export async function readInvitationNote(db: Db, invitationId: string, lang: string, original = false): Promise<InvitationNoteView | null> {
  return db.transaction(async tx => {
    const [invitation] = await tx.select().from(invitations).where(and(eq(invitations.id, invitationId), activeInvitation(new Date()))).for("share");
    if (!invitation?.note || !isLang(invitation.noteLang)) return null;
    const from = invitation.noteLang;
    const source: InvitationNoteView = { text: invitation.note, from, lang: from, translated: false, available: false, pending: false, unavailable: false };
    if (!isEnabledLang(lang) || lang === from) return source;
    const where = and(eq(invitationNoteTranslations.invitationId, invitationId), eq(invitationNoteTranslations.lang, lang));
    const [saved] = await tx.select().from(invitationNoteTranslations).where(where);
    if (saved?.state === "ready" && saved.text) {
      if (saved.text.normalize("NFKC").trim() === invitation.note.normalize("NFKC").trim()) return source;
      return { ...source, text: original ? invitation.note : saved.text, lang: original ? from : lang, translated: !original, available: true };
    }
    if (original) return source;
    if (saved?.state === "failed" || (await readPostTranslationWait(async () => tx)).kind === "stopped") return { ...source, unavailable: true };
    await tx.insert(invitationNoteTranslations).values({ invitationId, lang }).onConflictDoNothing();
    await enqueue(tx, TRANSLATE_INVITATION_NOTE_JOB, { invitationId, lang }, { dedupeKey: `invitation-note:${invitationId}:${lang}`, maxAttempts: 5, priority: 2 });
    return { ...source, pending: true };
  });
}

export async function invitationNoteSource(db: Db, payload: InvitationNotePayload) {
  const [row] = await db.select().from(invitations).where(and(eq(invitations.id, payload.invitationId), activeInvitation(new Date())));
  if (!row?.note || !isLang(row.noteLang) || row.noteLang === payload.lang || !isEnabledLang(payload.lang)) return null;
  const [saved] = await db.select().from(invitationNoteTranslations).where(and(eq(invitationNoteTranslations.invitationId, row.id), eq(invitationNoteTranslations.lang, payload.lang)));
  return saved?.state === "pending" ? { text: row.note, from: row.noteLang } : null;
}

export async function saveInvitationNoteTranslation(db: Db, payload: InvitationNotePayload, update: { state: "ready" | "failed"; text?: string; model?: string; promptVersion?: string }) {
  return db.transaction(async tx => {
    const [row] = await tx.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.id, payload.invitationId), activeInvitation(new Date()))).for("share");
    if (!row || !isEnabledLang(payload.lang)) return;
    await tx.update(invitationNoteTranslations).set(update).where(and(eq(invitationNoteTranslations.invitationId, row.id), eq(invitationNoteTranslations.lang, payload.lang), eq(invitationNoteTranslations.state, "pending")));
  });
}

// Notes are private invitation content, not permanent referral history. Purge
// all states 30 days after expiry; erased addresses or senders purge sooner.
export async function pruneInvitationNotes(db: Db, now = new Date(), results?: RetentionResults) {
  const where = and(isNotNull(invitations.note), or(lte(invitations.expiresAt, daysBefore(now, RETENTION.expiredInvitationDays)), isNull(invitations.email), isNull(invitations.createdBy)))!;
  // All eligible parents are already unusable. Reads and late provider writes
  // cannot recreate children, so each table can drain in its own bounded batches.
  // Keep the note until every child stage finishes, including after a hold or limit.
  const parents = db.select({ id: invitations.id }).from(invitations).where(where);
  const work = and(eq(jobs.kind, TRANSLATE_INVITATION_NOTE_JOB), inArray(sql`${jobs.payload}->>'invitationId'`, parents))!;
  const checkpoints = await drainRetentionRows(db, "invitation_note_checkpoints", jobs,
    and(work, or(sql`${jobs.payload} ? 'paidTranslationCalls'`, and(eq(jobs.status, "running"), sql`${jobs.payload}->>'discardPaidTranslationCalls' is distinct from 'true'`)))!, results,
    sql`payload = (${jobs.payload} - 'paidTranslationCalls') || case when ${jobs.status} = 'running' then '{"discardPaidTranslationCalls":true}'::jsonb else '{}'::jsonb end`);
  if (checkpoints.remaining) return;
  const queued = await drainRetentionRows(db, "invitation_note_jobs", jobs, and(work, eq(jobs.status, "queued"))!, results);
  if (queued.remaining) return;
  const translations = await drainRetentionRows(db, "invitation_note_translations", invitationNoteTranslations, inArray(invitationNoteTranslations.invitationId, parents), results);
  if (translations.remaining) return;
  await drainRetentionRows(db, "invitation_notes", invitations, where, results, sql`note = null, note_lang = null`);
}
