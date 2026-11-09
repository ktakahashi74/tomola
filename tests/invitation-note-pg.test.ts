import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { invitations, invitationNoteTranslations, jobs } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken } from "~/lib/invitations.server";
import { pruneInvitationNotes, readInvitationNote, saveInvitationNoteTranslation } from "~/lib/invitation-note.server";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { holdTx, waitForLockWait, expectSettlesWithin } from "./helpers/pg-concurrency";
import { deleteAccount } from "~/lib/account-delete.server";
import { createInvitationNoteHandlers } from "~/lib/jobs/invitation-note-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { runDueJobs } from "~/lib/jobs/queue.server";

describe.skipIf(!REAL_PG_URL)("invitation note races on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, admin: pg.Client, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    const db = await scratch.open(), sender = `note_sender_${++seq}`;
    await addMember(db, sender, sender);
    const made = await createInvitation(db, { email: `note_recipient_${seq}@example.com`, createdBy: sender, note: "論考を読んでほしい。" });
    return { db, row: (await findValidInvitationByToken(db, made.token))! };
  }
  it("deduplicates simultaneous first reads across connections", async () => {
    const { db, row } = await world();
    const a = await scratch.open(), b = await scratch.open();
    const views = await expectSettlesWithin(Promise.all([a, b].map(conn => readInvitationNote(conn, row.id, "en"))), 10000, "first reads");
    expect(views.every(view => view?.pending)).toBe(true);
    expect(await db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, `invitation-note:${row.id}:en`))).toHaveLength(1);
  });
  it.each(["revoked", "used", "purged"])("does not save a provider response after a concurrent %s update", async state => {
    const { db, row } = await world();
    await readInvitationNote(db, row.id, "en");
    const blocker = await scratch.open(), saving = await scratch.open("note-saving");
    const held = holdTx(blocker, async tx => {
      await tx.update(invitations).set(state === "revoked" ? { revokedAt: new Date() } : state === "used" ? { usedAt: new Date() } : { note: null, noteLang: null }).where(eq(invitations.id, row.id));
    });
    await held.ready;
    const pending = saveInvitationNoteTranslation(saving, { invitationId: row.id, lang: "en" }, { state: "ready", text: "late provider response" });
    try { await waitForLockWait(admin, "note-saving"); } finally { await held.commit(); }
    await expectSettlesWithin(pending, 10000, "late response");
    const [saved] = await db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id));
    expect(saved.text).toBeNull();
    expect(saved.state).toBe("pending");
  });
  it("removes queued work and fences a running paid checkpoint when retention expires", async () => {
    const { db, row } = await world();
    await readInvitationNote(db, row.id, "en");
    await db.update(jobs).set({ status: "running", payload: { invitationId: row.id, lang: "en", paidTranslationCalls: { saved: { result: { text: "private output" } } } } }).where(eq(jobs.dedupeKey, `invitation-note:${row.id}:en`));
    await pruneInvitationNotes(db, new Date(Date.now() + 45 * 86400000));
    const [work] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `invitation-note:${row.id}:en`));
    expect(work.payload).toEqual({ invitationId: row.id, lang: "en", discardPaidTranslationCalls: true });
    expect(await db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
  });
  it("discards a paid response arriving after account deletion without recreating notes or checkpoints", async () => {
    const { db, row } = await world();
    await db.delete(jobs);
    await readInvitationNote(db, row.id, "en");
    // Scratch connections keep wall-clock defaults; the worker uses the pinned
    // test clock. Make this job due explicitly before exercising provider I/O.
    await db.update(jobs).set({ runAt: new Date() });
    let started!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = createFakeEngine();
    const handlers = createInvitationNoteHandlers({ llm: { engines: { primary: { ...fake, async translate(req) {
      started(); await gate; return fake.translate(req);
    } }, secondary: null, judge: null } } });
    const worker = runDueJobs(await scratch.open(), handlers, { limit: 1, logger: { error() {}, warn() {} } });
    expect(await expectSettlesWithin(Promise.race([inside.then(() => true), worker.then(() => false)]), 5000, "provider entry")).toBe(true);
    try {
      await deleteAccount(db, row.createdBy!, { confirmation: row.createdBy! });
      expect((await db.select().from(invitations).where(eq(invitations.id, row.id)))[0]).toMatchObject({ note: null, noteLang: null });
      expect(await db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
    } finally { release(); await worker; }
    expect(await db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
    expect(JSON.stringify((await db.select().from(jobs)).map(job => job.payload))).not.toContain("paidTranslationCalls");
  });
});
