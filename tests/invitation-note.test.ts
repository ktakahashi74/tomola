import { createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { invitationNoteTranslations, invitations, jobs, llmUsage, profiles, retentionHold } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken, markInvitationUsed, revokeInvitation } from "~/lib/invitations.server";
import { invitationNoteText } from "~/lib/invitation-note";
import { pruneInvitationNotes, readInvitationNote, saveInvitationNoteTranslation } from "~/lib/invitation-note.server";
import { createInvitationNoteHandlers } from "~/lib/jobs/invitation-note-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { buildTranslationPrompt, INVITATION_NOTE_PROMPT_VERSION } from "~/lib/llm/prompt.server";
import type { TranslationEngine } from "~/lib/llm/types";
import Invite, { loader } from "~/routes/invite";
import { action } from "~/routes/invites-new";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { quietLogger } from "./helpers/logger";
import { m } from "~/paraglide/messages.js";
import { addMember, createTestDb } from "./helpers/db";
import { auditRetentionTransactions, expectBoundedTransactions } from "./helpers/retention";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
let seq = 0;
const note = "この論考について、あなたの視点から応えてほしい。 https://example.com/essay";
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("invite_note_sender", { homeArea: "ja" }); });
afterAll(() => h.restore());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function make(text = note) {
  const created = await createInvitation(h.db, { email: `note_${++seq}@example.com`, createdBy: h.ids.invite_note_sender, note: text });
  return { ...created, invitation: (await findValidInvitationByToken(h.db, created.token))! };
}
const run = (primary: TranslationEngine = createFakeEngine()) => runDueJobs(h.db, createInvitationNoteHandlers({ llm: { engines: { primary, secondary: null, judge: null } } }), { limit: 100, logger: quietLogger });

it("creates an optional note through the member action and detects its language", async () => {
  const out = await action(h.args(h.request("/invites/new", { as: "invite_note_sender", form: { email: "note_action@example.com", note } })));
  expect(out).toMatchObject({ error: null, url: expect.stringContaining("/invite/") });
  const [row] = await h.db.select().from(invitations).where(eq(invitations.email, "note_action@example.com"));
  expect(row).toMatchObject({ note, noteLang: "ja" });
  expect((await make("🙂")).invitation.noteLang).toBe("ja");
  expect((await make("")).invitation).toMatchObject({ note: null, noteLang: null });
  expect((await make("Please share your perspective on this essay.")).invitation.noteLang).toBe("en");
  await h.db.update(profiles).set({ homeArea: "ko" }).where(eq(profiles.userId, h.ids.invite_note_sender));
  try { expect((await make("🙂")).invitation.noteLang).toBe("ko"); }
  finally { await h.db.update(profiles).set({ homeArea: "ja" }).where(eq(profiles.userId, h.ids.invite_note_sender)); }
});

it("accepts 300 Unicode characters and rejects longer notes, controls and direction overrides", async () => {
  expect(invitationNoteText("🙂".repeat(300))).toHaveLength(600);
  for (const text of ["a".repeat(301), "🙂".repeat(301), "hello\nthere", "hello\tthere", "hello\u0000there", "hello\u202ethere", "hello\u2066there", "hello\u200bthere"]) {
    expect(invitationNoteText(text)).toBeNull();
    expect(await action(h.args(h.request("/invites/new", { as: "invite_note_sender", form: { email: "note_invalid@example.com", note: text } })))).toMatchObject({ error: "invalid_note" });
  }
  expect(await h.db.select().from(invitations).where(eq(invitations.email, "note_invalid@example.com"))).toEqual([]);
});

it("queues on reading only, deduplicates per language, shows the original while waiting, and reuses finished output", async () => {
  const { invitation: row } = await make();
  expect(await h.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
  expect(await readInvitationNote(h.db, row.id, "ja")).toMatchObject({ text: note, pending: false, available: false });
  for (let i = 0; i < 2; i++) expect(await readInvitationNote(h.db, row.id, "en")).toMatchObject({ text: note, pending: true });
  const work = await h.db.select().from(jobs).where(eq(jobs.dedupeKey, `invitation-note:${row.id}:en`));
  expect(work).toHaveLength(1);
  expect(work[0].payload).toEqual({ invitationId: row.id, lang: "en" });
  await run();
  expect(await readInvitationNote(h.db, row.id, "en")).toMatchObject({ text: `[en] ${note}`, translated: true, available: true, lang: "en" });
  expect(await readInvitationNote(h.db, row.id, "en", true)).toMatchObject({ text: note, translated: false, available: true, lang: "ja" });
  expect(await h.db.select().from(llmUsage).where(eq(llmUsage.purpose, "translate"))).not.toHaveLength(0);
  expect(await h.db.select().from(jobs).where(eq(jobs.dedupeKey, `invitation-note:${row.id}:en`))).toHaveLength(1);
});

it.each(["https://example.com/essay", "🙂", note])("shows unchanged translation output as unmarked original text (%s)", async text => {
  const { invitation: row, token } = await make(text);
  await readInvitationNote(h.db, row.id, "en");
  const fake = createFakeEngine();
  await run({ ...fake, async translate(req) { return { ...await fake.translate(req), text: req.text }; } });
  for (const original of [false, true]) {
    expect(await readInvitationNote(h.db, row.id, "en", original)).toEqual({ text, from: row.noteLang, lang: row.noteLang, available: false, translated: false, pending: false, unavailable: false });
  }
  const loaderData = await loader(h.args(h.request(`/invite/${token}`), { token }));
  const html = await renderInRouter(() => createElement(Invite, { loaderData } as never), `/invite/${token}`);
  expect(html).not.toContain(m.show_original());
  expect(html).not.toContain(m.label_no_translation());
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  expect(await readInvitationNote(h.db, row.id, "en")).toMatchObject({ text, pending: false, unavailable: false });
});

it("shows only the original and the generic unavailable message when the monthly budget is zero", async () => {
  const { invitation: row } = await make();
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  expect(await readInvitationNote(h.db, row.id, "en")).toMatchObject({ text: note, pending: false, unavailable: true });
  expect(await h.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
});

it("defers already queued work without calling the engine after the budget stops", async () => {
  const { invitation: row } = await make();
  await readInvitationNote(h.db, row.id, "en");
  const fake = createFakeEngine();
  const translate = vi.fn(fake.translate);
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  expect(await run({ ...fake, translate })).toMatchObject({ deferred: 1, failed: 0 });
  expect(translate).not.toHaveBeenCalled();
  expect(await readInvitationNote(h.db, row.id, "en")).toMatchObject({ text: note, unavailable: true, pending: false });
});

it("uses standalone plain-text prompts and never includes the recipient or invitation URL", () => {
  const prompt = buildTranslationPrompt({ text: note, from: "ja", to: "en", invitationNote: true }, "testnonce");
  expect(prompt.system).toContain("personal note");
  expect(prompt.system).toContain("plain text, not Markdown");
  expect(prompt.user).toContain(note);
  expect(prompt.user).not.toContain("@example.com");
});

it("renders attribution, the machine mark and original link, with URLs and markup left as text", async () => {
  const { invitation: row, token } = await make("論考を読んでほしい。 [link](https://example.com) <b>原文</b>");
  await readInvitationNote(h.db, row.id, "en"); await run();
  const loaderData = await loader(h.args(h.request(`/invite/${token}`), { token }));
  const html = await renderInRouter(() => createElement(Invite, { loaderData } as never), `/invite/${token}`);
  expect(html).toContain("invite_note_sender");
  expect(html).toContain(m.show_original());
  expect(html).toContain("&lt;b&gt;");
  expect(html).not.toContain('href="https://example.com"');
  expect(html).not.toContain("<b>原文</b>");
});

it.each(["used", "revoked", "expired"])("hides %s invitations and refuses late translation writes, then purges notes and cached translations", async state => {
  const { invitation: row, token } = await make();
  await readInvitationNote(h.db, row.id, "en"); await run();
  if (state === "used") await markInvitationUsed(h.db, row.email);
  if (state === "revoked") await revokeInvitation(h.db, h.ids.invite_note_sender, row.id);
  if (state === "expired") await h.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, row.id));
  expect(await readInvitationNote(h.db, row.id, "en")).toBeNull();
  const page = await loader(h.args(h.request(`/invite/${token}`), { token }));
  expect(page).toMatchObject({ email: null, note: null, from: null });
  await saveInvitationNoteTranslation(h.db, { invitationId: row.id, lang: "fr" }, { state: "ready", text: "late" });
  expect(await h.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.lang, "fr"))).toEqual([]);
  await pruneInvitationNotes(h.db, new Date(Date.now() + 45 * 86400000));
  expect((await h.db.select().from(invitations).where(eq(invitations.id, row.id)))[0]).toMatchObject({ note: null, noteLang: null });
  expect(await h.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
});

it("hides unusable engine output instead of showing an added link", async () => {
  const { invitation: row } = await make();
  await readInvitationNote(h.db, row.id, "en");
  const fake = createFakeEngine();
  await run({ ...fake, async translate(req) { return { ...await fake.translate(req), text: "Read https://evil.example instead.", promptVersion: INVITATION_NOTE_PROMPT_VERSION }; } });
  expect(await readInvitationNote(h.db, row.id, "en")).toMatchObject({ text: note, unavailable: true, pending: false });
});

it.each(["used", "expired"])("does not enqueue a first translation for a %s invitation", async state => {
  const { invitation: row } = await make();
  if (state === "used") await markInvitationUsed(h.db, row.email);
  else await h.db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, row.id));
  expect(await readInvitationNote(h.db, row.id, "en")).toBeNull();
  expect(await h.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
  expect(await h.db.select().from(jobs).where(eq(jobs.dedupeKey, `invitation-note:${row.id}:en`))).toEqual([]);
});

it("cascades cached translations when the invitation row is removed", async () => {
  const { invitation: row } = await make();
  await readInvitationNote(h.db, row.id, "en");
  await h.db.delete(invitations).where(eq(invitations.id, row.id));
  await run();
  expect(await h.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, row.id))).toEqual([]);
});

it("honors retention holds and changes at most 100 rows per cleanup transaction", async () => {
  const db = await createTestDb();
  await addMember(db, "bounded_note_sender", "bounded_note_sender");
  for (let i = 0; i < 45; i++) {
    const created = await createInvitation(db, { email: `bounded_note_${i}@example.com`, createdBy: "bounded_note_sender", note });
    const row = (await findValidInvitationByToken(db, created.token))!;
    for (const lang of ["en", "fr"]) await readInvitationNote(db, row.id, lang);
  }
  await auditRetentionTransactions(db, [invitations, invitationNoteTranslations, jobs]);
  await db.update(retentionHold).set({ active: true });
  const later = new Date(Date.now() + 45 * 86400000);
  await pruneInvitationNotes(db, later);
  expect((await db.select().from(invitations)).every(row => row.note === note)).toBe(true);
  await db.update(retentionHold).set({ active: false });
  await pruneInvitationNotes(db, later);
  expect((await db.select().from(invitations)).every(row => row.note === null)).toBe(true);
  expect(await db.select().from(invitationNoteTranslations)).toEqual([]);
  expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_invitation_note"))).toEqual([]);
  await expectBoundedTransactions(db, 225);
});
