import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { editedBodyFixture } from "./helpers/edited-body";
import { addMember } from "./helpers/db";
import { entries, jobs, profiles, translations, villages } from "~/lib/db/schema";
import { EDITED_BODY_DELAY_MS, REFRESH_BODY_JOB, TRANSLATE_JOB, translateDedupeKey, TRANSLATE_MAX_ATTEMPTS } from "~/lib/translations.server";
import { requestBodyTranslations } from "~/lib/translation-on-read.server";
import { resumeBudgetWaits } from "~/lib/jobs/budget-wait.server";
import { editEntry, softDeleteEntry } from "~/lib/entries.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { hideEntry, unhideEntry } from "~/lib/moderation.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";

afterEach(() => vi.unstubAllEnvs());

it.each(["topic", "reply"] as const)("refreshes only previously translated %s bodies outside the immediate audience", async kind => {
  const f = await editedBodyFixture(kind);
  await addMember(f.db, "reader", "refresh_reader");
  await f.db.update(profiles).set({ displayLang: "en" }).where(eq(profiles.userId, "reader"));
  await f.db.insert(translations).values([
    { entryId: f.id, field: "body", lang: "en", kind: "primary", text: "Earlier eager translation", sourceHash: f.original.sourceHash },
    { entryId: f.id, field: "body", lang: "de", kind: "human", text: "Earlier correction", sourceHash: f.original.sourceHash },
    { entryId: f.id, field: "body", lang: "fr", kind: "secondary", text: "Earlier comparison", sourceHash: f.original.sourceHash },
    { entryId: f.id, field: "title", lang: "ko", kind: "primary", text: "Title alone", sourceHash: f.original.sourceHash },
  ]);
  const now = new Date();
  await f.edit("A changed invented paragraph.", now);
  const delayed = await f.refreshes();
  expect(delayed.map(j => (j.payload as { lang: string }).lang).sort()).toEqual(["de", "fr"]);
  expect(delayed.every(j => j.runAt.getTime() === now.getTime() + 600_000)).toBe(true);
  const immediate = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  expect(immediate.map(j => (j.payload as { lang: string }).lang)).toEqual(["en"]);
  expect(immediate[0].runAt.getTime()).toBeLessThan(now.getTime() + 1000);
  expect((await f.db.select().from(translations).where(eq(translations.kind, "human")))[0].flags).toContain("stale");
  expect((await f.run(new Date(now.getTime() + EDITED_BODY_DELAY_MS - 1))).done).toBe(1);
  expect(f.calls.map(c => c.to)).toEqual(["en"]);
  await f.run(new Date(now.getTime() + EDITED_BODY_DELAY_MS));
  expect(f.calls.filter(c => c.field === "body").map(c => c.to).sort()).toEqual(["de", "en", "fr"]);
});

it.each([false, true])("debounces edits and translates the latest source without recording a display (ever seen: %s)", async everSeen => {
  const f = await editedBodyFixture();
  await f.db.update(translations).set({ everSeen });
  const firstTime = new Date();
  await f.edit("The first invented revision.", firstTime);
  const [first] = await f.refreshes();
  const lastTime = new Date(firstTime.getTime() + 120_000);
  const latest = await f.edit("The last invented revision.", lastTime);
  const [last] = await f.refreshes();
  expect(last.id).toBe(first.id);
  expect(last.runAt.getTime()).toBe(lastTime.getTime() + EDITED_BODY_DELAY_MS);
  expect(await f.run(first.runAt)).toMatchObject({ ran: 0 });
  await f.run(last.runAt);
  expect(f.calls.map(c => c.text)).toEqual([latest.body]);
  const [saved] = await f.db.select().from(translations).where(and(eq(translations.entryId, f.id), eq(translations.kind, "primary")));
  expect(saved).toMatchObject({ sourceHash: latest.sourceHash, mentionRevision: latest.mentionRevision, firstSeenAt: null, everSeen });
});

it.each(["queued", "running", "done"])("shares browser work when the revision job is %s", async status => {
  const f = await editedBodyFixture();
  const current = await f.edit("A revision requested by a reader.");
  const [delayed] = await f.refreshes();
  await requestBodyTranslations(f.db, [current], "fr", true);
  const [body] = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  if (status === "done") await f.run(new Date());
  else await f.db.update(jobs).set({ status, runAt: new Date(delayed.runAt.getTime() + 60_000), lockedAt: new Date(delayed.runAt) }).where(eq(jobs.id, body.id));
  const calls = f.calls.length;
  await f.run(delayed.runAt);
  expect(f.calls).toHaveLength(calls);
  const same = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  expect(same).toHaveLength(1);
  expect(same[0].id).toBe(body.id);
  expect(same[0].runAt).toEqual(status === "done" ? body.runAt : new Date(delayed.runAt.getTime() + 60_000));
});

it("lets a reader join dispatched refresh work without requesting another execution", async () => {
  const f = await editedBodyFixture();
  const current = await f.edit("A paragraph dispatched before its reader.");
  const [delayed] = await f.refreshes();
  await f.run(delayed.runAt, 1);
  const [body] = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  await f.db.update(jobs).set({ status: "running", lockedAt: delayed.runAt }).where(eq(jobs.id, body.id));
  await requestBodyTranslations(f.db, [current], "fr", true);
  expect((await f.db.select().from(jobs).where(eq(jobs.id, body.id)))[0].runAt).toEqual(body.runAt);
});

it.each(["deletedAt", "hiddenAt", "missing", "closedLanguage", "sourceLanguage"])("does no model work when a delayed post becomes %s", async state => {
  const f = await editedBodyFixture();
  await f.edit("A paragraph which becomes unavailable.");
  const [delayed] = await f.refreshes();
  if (state === "missing") await f.db.update(jobs).set({ payload: { entryId: 2147483647, lang: "fr" } }).where(eq(jobs.id, delayed.id));
  else if (state === "closedLanguage") vi.stubEnv("ENABLED_LANGS", "ja,en");
  else await f.db.update(entries).set(state === "sourceLanguage" ? { lang: "fr" } : { [state]: new Date() }).where(eq(entries.id, f.id));
  await f.run(delayed.runAt);
  expect(f.calls).toHaveLength(0);
  expect(await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB))).toHaveLength(0);
});

it.each((["unhide", "appeal"] as const).flatMap(restore =>
  (["edit while hidden", "waiting", "finished while hidden"] as const).map(phase => ({ restore, phase })),
))("requeues earlier body languages through $restore after $phase", async ({ restore, phase }) => {
  const f = await editedBodyFixture();
  await addMember(f.db, "moderator", "refresh_moderator");
  await addMember(f.db, "reviewer", "refresh_reviewer");
  await f.db.insert(translations).values({ entryId: f.id, field: "body", lang: "de", kind: "human", text: "An invented earlier correction.", sourceHash: f.original.sourceHash });
  const actor = { id: "moderator", scope: { operator: true, langs: [] } };
  const now = new Date();
  if (phase !== "edit while hidden") await f.edit("An invented revision before hiding.", now);
  const hidden = await hideEntry(f.db, actor, { entryId: f.id, reason: "spam", note: "An invented moderation reason." }, { now });
  if (!hidden.ok) throw new Error(hidden.error);
  if (phase === "edit while hidden") {
    await f.edit("An invented revision while hidden.", now);
    expect(await f.refreshes()).toHaveLength(0);
  } else {
    expect(await f.refreshes()).toHaveLength(2);
    if (phase === "finished while hidden") {
      await f.run(new Date(now.getTime() + EDITED_BODY_DELAY_MS));
      expect(await f.refreshes()).toHaveLength(0);
      expect(await f.db.select().from(jobs).where(eq(jobs.kind, REFRESH_BODY_JOB))).toEqual([
        expect.objectContaining({ status: "done" }), expect.objectContaining({ status: "done" }),
      ]);
      expect(f.calls).toHaveLength(0);
    }
  }
  const restoredAt = new Date(now.getTime() + EDITED_BODY_DELAY_MS + 60_000);
  if (restore === "unhide") {
    expect((await unhideEntry(f.db, actor, { entryId: f.id, reason: "other" }, { now: restoredAt })).ok).toBe(true);
  } else {
    const appeal = await createAppeal(f.db, "writer", hidden.actionId, "An invented appeal.", { now });
    if (!appeal.ok) throw new Error(appeal.error);
    expect(await decideAppeal(f.db, { ...actor, id: "reviewer" }, appeal.id, { decision: "overturned", note: "An invented decision." }, { now: restoredAt })).toMatchObject({ ok: true, reversed: true });
  }
  expect((await f.row()).hiddenAt).toBeNull();
  const delayed = await f.refreshes();
  expect(delayed.map(j => (j.payload as { lang: string }).lang).sort()).toEqual(["de", "fr"]);
  expect(delayed.every(j => j.runAt.getTime() === restoredAt.getTime() + EDITED_BODY_DELAY_MS)).toBe(true);
  await f.run(delayed[0].runAt);
  expect(f.calls.filter(c => ["de", "fr"].includes(c.to)).map(c => c.to).sort()).toEqual(["de", "fr"]);
});

it("uses the ordinary budget wait and attempt limit without calling the engine while stopped", async () => {
  const f = await editedBodyFixture();
  await f.edit("An invented paragraph held by the monthly limit.");
  const [delayed] = await f.refreshes();
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  expect(await f.run(delayed.runAt)).toMatchObject({ done: 1, deferred: 1, failed: 0 });
  expect(f.calls).toHaveLength(0);
  const [body] = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  expect(body).toMatchObject({ status: "queued", attempts: 0, maxAttempts: TRANSLATE_MAX_ATTEMPTS });
  expect(body.lastError).toContain("deferred:");
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "20");
  await resumeBudgetWaits(f.db, delayed.runAt);
  await f.run(new Date(body.runAt.getTime() + 1));
  expect(f.calls).toHaveLength(1);
});

it("preserves a terminal browser failure instead of granting another attempt budget", async () => {
  const f = await editedBodyFixture();
  const current = await f.edit("An invented paragraph with exhausted retries.");
  const [delayed] = await f.refreshes();
  await f.db.insert(jobs).values({ kind: TRANSLATE_JOB, status: "failed", attempts: 10, dedupeKey: translateDedupeKey({ entryId: f.id, lang: "fr", sourceHash: current.sourceHash! }, current.lang), payload: { entryId: f.id, lang: "fr", sourceHash: current.sourceHash } });
  await f.run(delayed.runAt);
  expect(f.calls).toHaveLength(0);
  expect(await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB))).toHaveLength(1);
});

it("captures previous languages before source-language cleanup and cancels old delayed work", async () => {
  const f = await editedBodyFixture();
  await f.edit("An intermediate source revision.");
  const [old] = await f.refreshes();
  const current = await f.edit("An invented source with corrected language.", new Date(), "en");
  const work = await f.refreshes();
  expect(work).toHaveLength(1);
  expect(work[0].id).not.toBe(old.id);
  await f.run(work[0].runAt);
  expect(f.calls.filter(c => c.to === "fr")).toHaveLength(1);
  expect(f.calls.find(c => c.to === "fr")).toMatchObject({ from: "en", to: "fr", text: current.body });
});

it("renews the delay after language cleanup removed all earlier translation rows", async () => {
  const f = await editedBodyFixture();
  const firstTime = new Date();
  await f.edit("A source whose language changes.", firstTime, "en");
  const [first] = await f.refreshes();
  expect(await f.db.select().from(translations)).toHaveLength(0);
  const lastTime = new Date(firstTime.getTime() + 60_000);
  await f.edit("The next version after language cleanup.", lastTime, "en");
  const [last] = await f.refreshes();
  expect(last.id).toBe(first.id);
  expect(last.runAt.getTime()).toBe(lastTime.getTime() + EDITED_BODY_DELAY_MS);
});

it("retains the earlier audience when an edit races with dispatched work after language cleanup", async () => {
  const f = await editedBodyFixture();
  await f.edit("A source whose language changes before dispatch.", new Date(), "en");
  const [first] = await f.refreshes();
  // Select only the dispatcher; the eager source-language body can run separately.
  await runDueJobs(f.db, { [REFRESH_BODY_JOB]: f.handlers[REFRESH_BODY_JOB] }, { now: first.runAt });
  expect(await f.db.select().from(translations)).toHaveLength(0);
  const lastTime = new Date(first.runAt.getTime() + 60_000);
  await f.edit("Another revision while dispatched work is pending.", lastTime, "en");
  const [last] = await f.refreshes();
  expect(last.runAt.getTime()).toBe(lastTime.getTime() + EDITED_BODY_DELAY_MS);
});

it("rearms an older running revision when identical source text returns before delayed dispatch", async () => {
  const f = await editedBodyFixture();
  const earlier = await f.edit("An invented source which will return.");
  await requestBodyTranslations(f.db, [earlier], "fr", true);
  const [body] = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  await f.edit("A temporary intervening paragraph.");
  const current = await f.edit(earlier.body);
  expect(current.sourceHash).toBe(earlier.sourceHash);
  const [delayed] = await f.refreshes();
  await f.db.update(jobs).set({ status: "running", lockedAt: delayed.runAt }).where(eq(jobs.id, body.id));
  await f.run(delayed.runAt);
  const [rearmed] = await f.db.select().from(jobs).where(eq(jobs.id, body.id));
  expect(rearmed.runAt.getTime()).toBeGreaterThan(body.runAt.getTime());
  expect(rearmed.payload).toMatchObject({ readRevision: current.mentionRevision });
  expect(f.calls).toHaveLength(0);
  await requestBodyTranslations(f.db, [current], "fr", true);
  expect((await f.db.select().from(jobs).where(eq(jobs.id, body.id)))[0].runAt).toEqual(rearmed.runAt);
});

it("removes queued refresh work during ordinary deletion", async () => {
  const f = await editedBodyFixture();
  await f.edit("An invented paragraph to delete.");
  expect(await f.refreshes()).toHaveLength(1);
  await softDeleteEntry(f.db, f.id);
  expect(await f.refreshes()).toHaveLength(0);
});

it("keeps a restored current translation and unchanged body carryover without another call", async () => {
  const f = await editedBodyFixture();
  // Legacy rows without a mention revision remain current when identical text returns.
  await f.edit("A temporary invented change.");
  await f.edit(f.original.body);
  const [delayed] = await f.refreshes();
  await f.run(delayed.runAt);
  expect(f.calls).toHaveLength(0);
  expect((await editEntry(f.db, "writer", f.id, { title: "An invented title", body: f.original.body })).ok).toBe(true);
  const [carried] = await f.refreshes();
  await runDueJobs(f.db, { [REFRESH_BODY_JOB]: f.handlers[REFRESH_BODY_JOB] }, { now: carried.runAt });
  expect(f.calls).toHaveLength(0);
  expect(await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB))).toHaveLength(0);
});

it("uses the immediate path's village boundary without broadening public reading", async () => {
  const f = await editedBodyFixture();
  const villageId = "1234567890abcdef1234567890abcdef";
  await f.db.insert(villages).values({ id: villageId, slug: villageId, name: "Invented private village", kind: "closed", sourceLang: "ja" });
  await f.db.update(entries).set({ villageId }).where(eq(entries.id, f.id));
  await f.edit("An invented paragraph in a closed village.");
  const [delayed] = await f.refreshes();
  await f.run(delayed.runAt);
  expect(f.calls).toHaveLength(1);
  expect((await f.db.select().from(entries).where(eq(entries.id, f.id)))[0].villageId).toBe(villageId);
});
