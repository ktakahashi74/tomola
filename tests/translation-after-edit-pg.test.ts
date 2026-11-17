import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { editedBodyFixture } from "./helpers/edited-body";
import { PG_MODE } from "./helpers/pg-test";
import { expectPending, holdTx } from "./helpers/pg-concurrency";
import { entries, jobs } from "~/lib/db/schema";
import { applyEntryEdit } from "~/lib/entries.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { EDITED_BODY_DELAY_MS, REFRESH_BODY_JOB, TRANSLATE_JOB } from "~/lib/translations.server";
import { requestBodyTranslations } from "~/lib/translation-on-read.server";
import { addMember } from "./helpers/db";
import { hideEntry, unhideEntry } from "~/lib/moderation.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";

afterEach(() => vi.unstubAllEnvs());

it.skipIf(!PG_MODE).each(["unhide", "appeal"] as const)("rolls back visibility and delayed refreshes together through %s", { tags: ["postgres"] }, async restore => {
  const f = await editedBodyFixture();
  await addMember(f.db, "moderator", "refresh_moderator");
  await addMember(f.db, "reviewer", "refresh_reviewer");
  const actor = { id: "moderator", scope: { operator: true, langs: [] } };
  const now = new Date();
  const hidden = await hideEntry(f.db, actor, { entryId: f.id, reason: "spam", note: "An invented moderation reason." }, { now });
  if (!hidden.ok) throw new Error(hidden.error);
  await f.edit("An invented revision while hidden.", now);
  const appeal = await createAppeal(f.db, "writer", hidden.actionId, "An invented appeal.", { now });
  if (!appeal.ok) throw new Error(appeal.error);
  const rollback = new Error("Abort the invented visibility change");
  await expect(f.db.transaction(async tx => {
    if (restore === "unhide") {
      expect((await unhideEntry(tx, actor, { entryId: f.id, reason: "other" }, { now })).ok).toBe(true);
    } else {
      expect(await decideAppeal(tx, { ...actor, id: "reviewer" }, appeal.id, { decision: "overturned", note: "An invented decision." }, { now })).toMatchObject({ ok: true, reversed: true });
    }
    expect(await tx.select().from(jobs).where(eq(jobs.kind, REFRESH_BODY_JOB))).toHaveLength(1);
    throw rollback;
  })).rejects.toBe(rollback);
  expect((await f.row()).hiddenAt).toEqual(now);
  expect(await f.refreshes()).toHaveLength(0);
});

it.skipIf(!PG_MODE)("serializes simultaneous browser and delayed dispatch into one revision job", { tags: ["postgres"] }, async () => {
  const f = await editedBodyFixture();
  const current = await f.edit("An invented revision with concurrent readers.");
  const [delayed] = await f.refreshes();
  const held = holdTx(f.db, tx => tx.select().from(entries).where(eq(entries.id, f.id)).for("no key update"));
  await held.ready;
  const dispatch = f.run(delayed.runAt, 1);
  const browser = requestBodyTranslations(f.db, [current], "fr", true);
  try { await Promise.all([expectPending(dispatch), expectPending(browser)]); }
  finally { await held.commit(); }
  await Promise.all([dispatch, browser]);
  const work = await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB));
  expect(work).toHaveLength(1);
  await f.run(delayed.runAt);
  expect(f.calls.map(c => c.text)).toEqual([current.body]);
});

it.skipIf(!PG_MODE)("keeps the new delay when another edit commits after a refresh was claimed", { tags: ["postgres"] }, async () => {
  const f = await editedBodyFixture();
  await f.edit("An invented revision before claiming.");
  const [delayed] = await f.refreshes();
  let claimed!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(r => { claimed = r; });
  const gate = new Promise<void>(r => { release = r; });
  const running = runDueJobs(f.db, { [REFRESH_BODY_JOB]: async (job, ctx) => {
    claimed(); await gate;
    await f.handlers[REFRESH_BODY_JOB](job, ctx);
  } }, { now: delayed.runAt, limit: 1 });
  await ready;
  const lastTime = new Date(delayed.runAt.getTime() + 60_000);
  let current;
  try { current = await f.edit("The final invented revision after claiming.", lastTime); }
  finally { release(); }
  await running;
  const [rearmed] = await f.refreshes();
  expect(rearmed.id).toBe(delayed.id);
  expect(rearmed.runAt.getTime()).toBe(lastTime.getTime() + EDITED_BODY_DELAY_MS);
  expect(f.calls).toHaveLength(0);
  expect(await f.db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_JOB))).toHaveLength(0);
  await f.run(rearmed.runAt);
  expect(f.calls.map(c => c.text)).toEqual([current!.body]);
});

it.skipIf(!PG_MODE)("rolls back source edits and refresh rescheduling together", { tags: ["postgres"] }, async () => {
  const f = await editedBodyFixture();
  const current = await f.edit("An invented committed revision.");
  const [delayed] = await f.refreshes();
  const rollback = new Error("Abort the invented edit");
  await expect(f.db.transaction(async tx => {
    await tx.select().from(entries).where(eq(entries.id, f.id)).for("no key update");
    await applyEntryEdit(tx, { entryId: f.id, editorId: "writer", now: new Date(delayed.runAt.getTime() + 1),
      before: current, after: { title: null, body: "An invented rolled-back revision.", html: "" } });
    throw rollback;
  })).rejects.toBe(rollback);
  expect((await f.row()).sourceHash).toBe(current.sourceHash);
  expect((await f.refreshes())[0].runAt).toEqual(delayed.runAt);
});
