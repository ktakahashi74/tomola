import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { appeals, entries, entryMentionSnapshots, entryRevisions, memberSignatures, moderationActions, reports, retentionHold, translationReports } from "~/lib/db/schema";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { pruneDeletedEntries } from "~/lib/entry-retention.server";
import { runMaintenanceCleanup } from "~/lib/jobs/maintenance-jobs.server";
import { PURGED_QUESTION_TITLE } from "~/lib/retention";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import type { Db } from "~/lib/db/client.server";
import { FixBeforeNow } from "~/components/fix-before-now";
import { m } from "~/paraglide/messages.js";
import { auditRetentionTransactions, expectBoundedTransactions } from "./helpers/retention";
import type { RetentionResults } from "~/lib/retention-batch.server";

const NOW = new Date("2030-03-31T12:00:00Z"), DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
async function world() {
  const db = await createTestDb();
  for (const [id, handle] of [["a", "alice"], ["m", "moriko"], ["r", "reviewer"]]) await addMember(db, id, handle);
  return db;
}
async function post(db: Db, extra: Partial<typeof entries.$inferInsert> = {}) {
  const [row] = await db.insert(entries).values({ kind: "topic", authorId: "a", lang: "en", title: "Private title", body: "Private source", sourceHash: "private-hash", deletedAt: ago(31), ...extra }).returning();
  return row;
}
async function revision(db: Db, entryId: number, fixed: boolean) {
  const [rev] = await db.insert(entryRevisions).values({ entryId, title: "Earlier title", body: "Earlier body", editorId: "a" }).returning();
  if (!fixed) return { rev, action: null };
  const [action] = await db.insert(moderationActions).values({ action: "fix_entry", targetEntryId: entryId, actorId: "m", reason: "other", revisionId: rev.id }).returning();
  return { rev, action };
}

it.skipIf(!PG_MODE).each([1, 100])("drains 350 available revisions past %i locked copies in one invocation", { tags: ["postgres"], timeout: 30_000 }, async lockedCount => {
  const db = await world();
  const sources = await db.insert(entries).values(Array.from({ length: lockedCount + 350 }, () => ({ kind: "topic" as const, authorId: "a", lang: "en" as const, body: "", deletedAt: ago(31) }))).returning();
  const revisions = await db.insert(entryRevisions).values(sources.map(entry => ({ entryId: entry.id, body: "Private revision", editorId: "a" }))).returning();
  await auditRetentionTransactions(db, [entries, entryRevisions]);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const held = db.transaction(async tx => {
    for (const revision of revisions.slice(0, lockedCount)) await tx.select().from(entryRevisions).where(eq(entryRevisions.id, revision.id)).for("update");
    entered(); await gate;
  });
  await inside;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const results: RetentionResults = {};
    expect(await pruneDeletedEntries(db, NOW, results)).toMatchObject({ revisionsDeleted: 350 });
    expect(results.entry_content).toMatchObject({ removed: 350, remaining: lockedCount, skipped: lockedCount, stop: "deferred" });
    expect((await db.select().from(entryRevisions)).map(row => row.id).sort((a, b) => a - b)).toEqual(revisions.slice(0, lockedCount).map(row => row.id).sort((a, b) => a - b));
    await expectBoundedTransactions(db, 350);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`"skipped":${lockedCount}`));
  } finally { log.mockRestore(); release(); await held; }
  expect(await pruneDeletedEntries(db, NOW)).toMatchObject({ revisionsDeleted: lockedCount });
  expect(await db.select().from(entryRevisions)).toEqual([]);
});

it("keeps content up to the cutoff, removes all source copies after it, and preserves reply positions", async () => {
  const db = await world();
  const topic = await post(db, { deletedAt: ago(30) });
  const reply = await post(db, { kind: "reply", title: null, threadId: topic.id, parentId: topic.id, deletedAt: ago(30) });
  const child = await post(db, { kind: "reply", title: null, threadId: topic.id, parentId: reply.id, deletedAt: null });
  await revision(db, reply.id, false);
  await db.insert(entryMentionSnapshots).values({ entryId: reply.id, revision: 0, sourceHash: "h", body: "Copied body", bindings: [] });
  await db.insert(memberSignatures).values({ userId: "a", entryId: reply.id, operation: "create-reply", payload: '{"input":{"body":"Copied body"}}', payloadHash: "h", challenge: "c", credentialId: "k", publicKey: "k", rpId: "example.org", origin: "https://example.org", assertion: {}, authenticatorData: "a", clientDataJson: "c", signature: "s" });
  expect(await pruneDeletedEntries(db, NOW)).toEqual({ entries: 0, revisionsDeleted: 0, revisionsPruned: 0 });
  const after = new Date(NOW.getTime() + 1);
  expect(await pruneDeletedEntries(db, after)).toMatchObject({ entries: 2, revisionsDeleted: 1, revisionsPruned: 0 });
  expect((await db.select().from(entries).where(eq(entries.id, reply.id)))[0]).toMatchObject({ body: "", title: null, sourceHash: null, threadId: topic.id, parentId: topic.id, deletedAt: ago(30) });
  expect((await db.select().from(entries).where(eq(entries.id, child.id)))[0]).toMatchObject({ body: "Private source", parentId: reply.id });
  expect(await db.select().from(entryRevisions)).toEqual([]);
  expect(await db.select().from(entryMentionSnapshots)).toEqual([]);
  expect(await db.select().from(memberSignatures)).toEqual([]);
  expect(await pruneDeletedEntries(db, after)).toEqual({ entries: 0, revisionsDeleted: 0, revisionsPruned: 0 });
});

it("keeps hidden, operator-deleted and appealed content, including an appeal on a report's member action", async () => {
  const db = await world();
  const hidden = await post(db, { hiddenAt: ago(32) });
  const operator = await post(db);
  const [deleted] = await db.insert(moderationActions).values({ action: "delete", targetEntryId: operator.id, actorId: "m", reason: "other" }).returning();
  await db.update(entries).set({ moderationActionId: deleted.id }).where(eq(entries.id, operator.id));
  const pending = await post(db);
  const { action } = await revision(db, pending.id, true);
  await db.insert(appeals).values({ actionId: action!.id, appellantId: "a", text: "Please review" });
  const allowed = await post(db, { asksStance: true });
  const reported = await post(db);
  const [report] = await db.insert(reports).values({ entryId: reported.id, reporterId: "m", reason: "other", status: "resolved", handledAt: ago(32) }).returning();
  const [suspension] = await db.insert(moderationActions).values({ action: "suspend", targetUserId: "a", reportId: report.id, actorId: "m", reason: "other", until: ago(-1) }).returning();
  await db.insert(appeals).values({ actionId: suspension.id, appellantId: "a", text: "Review the reported post" });
  await pruneDeletedEntries(db, NOW);
  for (const id of [hidden.id, operator.id, pending.id, reported.id]) expect((await db.select().from(entries).where(eq(entries.id, id)))[0].body).toBe("Private source");
  // The original title is erased; a fixed marker satisfies question constraints.
  expect((await db.select().from(entries).where(eq(entries.id, allowed.id)))[0]).toMatchObject({ body: "", title: PURGED_QUESTION_TITLE, asksStance: true });
});

it("explains unavailable original text to both users of the shared appeal comparison", () => {
  const rendered = renderToStaticMarkup(createElement(FixBeforeNow, { before: null, now: { title: "", body: "" }, lang: "en" }));
  expect(rendered).toContain(m.appeal_fix_pruned());
  expect(rendered).toContain('role="status"');
  expect(rendered).not.toContain('data-testid="fix-before"');
});

it("retains only empty referenced revision markers, shows late appeals as unavailable, and never restores them", async () => {
  const db = await world();
  const topic = await post(db, { asksStance: true });
  const { rev, action } = await revision(db, topic.id, true);
  await revision(db, topic.id, false);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMaintenanceCleanup(db, NOW);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"revisionsDeleted":1,"revisionsPruned":1'));
  } finally { log.mockRestore(); }
  expect(await db.select().from(entryRevisions)).toMatchObject([{ id: rev.id, title: null, body: "" }]);
  const late = await createAppeal(db, "a", action!.id, "Please review", { now: NOW });
  if (!late.ok) throw new Error(late.error);
  expect((await getAppealableAction(db, "a", action!.id))?.before).toBeNull();
  expect((await listOpenAppeals(db, { id: "r", scope: { operator: true, langs: [] } })).cards[0].before).toBeNull();
  expect(await decideAppeal(db, { id: "r", scope: { operator: true, langs: [] } }, late.id, { decision: "overturned", note: "Cannot recover purged text" }, { now: NOW })).toMatchObject({ ok: true, reversed: false });
  expect((await db.select().from(entries).where(eq(entries.id, topic.id)))[0]).toMatchObject({ body: "", title: PURGED_QUESTION_TITLE, sourceHash: null });
});

it("preservation stops entry, revision and mention removal", async () => {
  const db = await world();
  const topic = await post(db);
  await revision(db, topic.id, true);
  await db.insert(entryMentionSnapshots).values({ entryId: topic.id, revision: 0, body: "copy", bindings: [] });
  await db.update(retentionHold).set({ active: true });
  await pruneDeletedEntries(db, NOW);
  expect((await db.select().from(entries))[0].body).toBe("Private source");
  expect((await db.select().from(entryRevisions))[0].body).toBe("Earlier body");
  expect(await db.select().from(entryMentionSnapshots)).toHaveLength(1);
});

it("drains sources and large revision and excerpt histories with at most 100 changed rows per transaction", async () => {
  const db = await world();
  const rows = await db.insert(entries).values(Array.from({ length: 350 }, () => ({ kind: "topic", authorId: "a", lang: "en", body: "private", deletedAt: ago(31) }))).returning({ id: entries.id });
  await db.insert(entryRevisions).values(Array.from({ length: 350 }, () => ({ entryId: rows[0].id, body: "private version", editorId: "a" })));
  await db.insert(translationReports).values(Array.from({ length: 350 }, (_, i) => ({ entryId: rows[0].id, lang: "ja", field: "body", reporterId: "r", excerpt: "Translated private text", note: `Reporter's note ${i}`, status: i % 2 ? "open" : "resolved" })));
  await auditRetentionTransactions(db, [entries, entryRevisions, translationReports]);
  expect((await pruneDeletedEntries(db, NOW)).entries).toBe(350);
  expect(await db.select().from(entryRevisions)).toEqual([]);
  expect(await db.select().from(entries).where(eq(entries.body, "private"))).toEqual([]);
  const reports = await db.select().from(translationReports).orderBy(translationReports.id);
  expect(reports).toHaveLength(350);
  reports.forEach((report, i) => expect(report).toMatchObject({ excerpt: "", note: `Reporter's note ${i}`, status: i % 2 ? "open" : "resolved" }));
  await expectBoundedTransactions(db, 1050);
  // Excerpts created after source erasure are still found on subsequent runs.
  const [lateReport] = await db.insert(translationReports).values({ entryId: rows[0].id, lang: "en", field: "title", reporterId: "r", excerpt: "Late copy", note: "Keep this note" }).returning({ id: translationReports.id });
  await pruneDeletedEntries(db, NOW);
  expect((await db.select().from(translationReports).where(eq(translationReports.id, lateReport.id)))[0]).toMatchObject({ excerpt: "", note: "Keep this note" });
});

it.skipIf(!PG_MODE)("an appeal opened during cleanup's entry lock is serialized with pruning", { tags: ["postgres"] }, async () => {
  const db = await world();
  const topic = await post(db);
  const { action } = await revision(db, topic.id, true);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const first = db.transaction(async tx => {
    const result = await createAppeal(tx, "a", action!.id, "Pending review");
    entered(); await gate; return result;
  });
  await inside;
  try {
    // SKIP LOCKED leaves this entry for another pass rather than waiting.
    expect((await pruneDeletedEntries(db, NOW)).entries).toBe(0);
  } finally { release(); }
  expect(await first).toMatchObject({ ok: true });
  expect((await db.select().from(entries).where(eq(entries.id, topic.id)))[0].body).toBe("Private source");
});
