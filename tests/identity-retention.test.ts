import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { appeals, entries, entryMedia, media, moderationActions, profiles, reports, retentionHold } from "~/lib/db/schema";
import { createAppeal, decideAppeal, getAppealableAction } from "~/lib/appeals.server";
import { pruneIdentitySnapshots } from "~/lib/identity-retention.server";
import { runMaintenanceCleanup } from "~/lib/jobs/maintenance-jobs.server";
import { readMedia } from "~/lib/media-store.server";
import { RETENTION, RETENTION_BATCH_SIZE, RETENTION_MAX_BATCHES, daysBefore } from "~/lib/retention";
import { withRetentionRun } from "~/lib/retention-batch.server";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { auditRetentionTransactions, expectBoundedTransactions } from "./helpers/retention";

const NOW = new Date("2030-03-31T12:00:00Z");
const cutoff = daysBefore(NOW, RETENTION.identityReportDays);
const OLD = new Date(cutoff.getTime() - 1);
const names = { displayName: "名前の写し", displayNameLatin: "Saved Name" };
const imageId = (i: number) => i.toString(16).padStart(64, "0");
async function world() {
  const db = await createTestDb();
  for (const id of ["writer", "operator", "reporter", "reviewer"]) await addMember(db, id, `ir_${id}`);
  return db;
}
async function image(db: Db, i: number) {
  await db.insert(media).values({ id: imageId(i), avatar: true, bytes: Buffer.from("avatar"), mime: "image/webp", width: 256, height: 256, byteSize: 6, uploadedBy: "writer", uploadedAt: OLD });
  return imageId(i);
}
async function evidence(db: Db, kind: "avatar" | "display_name", opts: { at?: Date; handledAt?: Date | null; status?: string; image?: number } = {}) {
  const saved = kind === "avatar" ? await image(db, opts.image ?? 1) : null;
  const [report] = await db.insert(reports).values({
    ...(kind === "avatar" ? { avatarUserId: "writer", avatarMediaId: saved } : { displayNameUserId: "writer", displayNamesReported: names }),
    reporterId: "reporter", reason: "other", status: opts.status ?? "resolved", createdAt: OLD,
    handledAt: opts.handledAt === undefined ? opts.at ?? OLD : opts.handledAt,
  }).returning();
  const [action] = await db.insert(moderationActions).values({ action: `clear_${kind}`, targetUserId: "writer", actorId: "operator", reason: "other", note: "Review", reportId: report.id, createdAt: opts.at ?? OLD,
    ...(kind === "avatar" ? { avatarMediaIdBefore: saved } : { displayNamesBefore: names }) }).returning();
  return { action, report, saved };
}

it.each(["avatar", "display_name"] as const)("expires %s copies strictly after each handling/creation cutoff and keeps history", async kind => {
  const db = await world();
  const { action, report } = await evidence(db, kind, { at: cutoff });
  await pruneIdentitySnapshots(db, NOW);
  expect((await db.select().from(moderationActions))[0]).toEqual(action);
  expect((await db.select().from(reports))[0]).toEqual(report);
  const after = new Date(NOW.getTime() + 1);
  await pruneIdentitySnapshots(db, after);
  expect(await db.select().from(moderationActions)).toEqual([{ ...action, avatarMediaIdBefore: null, displayNamesBefore: null }]);
  expect(await db.select().from(reports)).toEqual([{ ...report, avatarMediaId: null, displayNamesReported: null }]);
  if (kind === "avatar") expect(await readMedia(db, imageId(1))).toBeNull();
  expect(Object.values(await pruneIdentitySnapshots(db, after)).every(result => result.removed === 0 && result.remaining === 0)).toBe(true);
});

it.each(["avatar", "display_name"] as const)("keeps open, undated and recently handled %s reports despite old creation times", async kind => {
  const db = await world();
  for (const [i, opts] of [{ status: "open", handledAt: null }, { status: "resolved", handledAt: null }, { status: "dismissed", handledAt: cutoff }].entries()) {
    await evidence(db, kind, { ...opts, image: i + 1 });
  }
  const before = await db.select().from(reports);
  await pruneIdentitySnapshots(db, NOW);
  expect(await db.select().from(reports)).toEqual(before);
  expect((await db.select().from(moderationActions)).every(action => action.avatarMediaIdBefore === null && action.displayNamesBefore === null)).toBe(true);
  if (kind === "avatar") expect((await db.select().from(media)).every(row => row.bytes !== null)).toBe(true);
});

it.each(["avatar", "display_name"] as const)("protects related %s reports until 180 days after an appeal decision", async kind => {
  const db = await world();
  const { action, report } = await evidence(db, kind);
  const [secondary] = await db.insert(reports).values({ avatarUserId: report.avatarUserId, avatarMediaId: report.avatarMediaId,
    displayNameUserId: report.displayNameUserId, displayNamesReported: report.displayNamesReported,
    reporterId: "reviewer", reason: "other", status: "resolved", handledAt: OLD }).returning();
  const filed = await createAppeal(db, "writer", action.id, "Please review", { now: OLD });
  if (!filed.ok) throw Error(filed.error);
  const before = await db.select().from(reports);
  await pruneIdentitySnapshots(db, NOW);
  expect(await db.select().from(reports)).toEqual(before);
  expect((await db.select().from(moderationActions))[0]).toEqual(action);
  await db.update(appeals).set({ status: "upheld", decidedAt: null }).where(eq(appeals.id, filed.id));
  await pruneIdentitySnapshots(db, NOW);
  expect(await db.select().from(reports)).toEqual(before);
  await db.update(appeals).set({ decidedAt: cutoff }).where(eq(appeals.id, filed.id));
  await pruneIdentitySnapshots(db, NOW);
  expect(await db.select().from(reports)).toEqual(before);
  await pruneIdentitySnapshots(db, new Date(NOW.getTime() + 1));
  expect((await db.select().from(reports).orderBy(reports.id)).map(row => row.id)).toEqual([report.id, secondary.id]);
  expect((await db.select().from(reports)).every(row => row.avatarMediaId === null && row.displayNamesReported === null)).toBe(true);
  expect((await db.select().from(moderationActions))[0]).toMatchObject({ id: action.id, avatarMediaIdBefore: null, displayNamesBefore: null });
});

it("protects evidence for an appeal on a report-linked member action without blocking the other identity kind", async () => {
  const db = await world();
  const nameCase = await evidence(db, "display_name");
  await evidence(db, "avatar");
  const [action] = await db.insert(moderationActions).values({ action: "suspend", targetUserId: "writer", reportId: nameCase.report.id, actorId: "operator", reason: "other", until: NOW, createdAt: OLD }).returning();
  await db.insert(appeals).values({ actionId: action.id, appellantId: "writer", text: "Review" });
  await pruneIdentitySnapshots(db, NOW);
  expect((await db.select().from(reports).where(eq(reports.id, nameCase.report.id)))[0].displayNamesReported).toEqual(names);
  expect((await db.select().from(moderationActions).where(eq(moderationActions.id, nameCase.action.id)))[0].displayNamesBefore).toEqual(names);
  expect(await readMedia(db, imageId(1))).toBeNull();
});

it.each(["avatar", "display_name"] as const)("preserves the protected %s copy when a row also contains expired evidence of the other kind", async kind => {
  const db = await world();
  const { action, report } = await evidence(db, kind);
  const imageRef = kind === "avatar" ? report.avatarMediaId! : await image(db, 1);
  await db.update(reports).set({ avatarMediaId: imageRef, displayNamesReported: names }).where(eq(reports.id, report.id));
  await db.update(moderationActions).set({ avatarMediaIdBefore: imageRef, displayNamesBefore: names }).where(eq(moderationActions.id, action.id));
  await db.insert(appeals).values({ actionId: action.id, appellantId: "writer", text: "Review" });
  await pruneIdentitySnapshots(db, NOW);
  const [remainingReport] = await db.select().from(reports);
  const [remainingAction] = await db.select().from(moderationActions);
  expect(remainingReport).toMatchObject({ avatarMediaId: kind === "avatar" ? imageRef : null, displayNamesReported: kind === "display_name" ? names : null });
  expect(remainingAction).toMatchObject({ avatarMediaIdBefore: kind === "avatar" ? imageRef : null, displayNamesBefore: kind === "display_name" ? names : null });
});

it("erases avatar bytes only after every evidence, profile and post reference is gone", async () => {
  const db = await world();
  await evidence(db, "avatar");
  const current = await image(db, 2), postImage = await image(db, 3), reported = await image(db, 4);
  await db.update(profiles).set({ avatarMediaId: current }).where(eq(profiles.userId, "writer"));
  const [post] = await db.insert(entries).values({ kind: "topic", authorId: "writer", lang: "en", body: "Image" }).returning();
  await db.insert(entryMedia).values({ entryId: post.id, mediaId: postImage });
  const [report] = await db.insert(reports).values({ avatarUserId: "writer", avatarMediaId: reported, reporterId: "reporter", reason: "other" }).returning();
  await pruneIdentitySnapshots(db, NOW);
  expect(await readMedia(db, imageId(1))).toBeNull();
  for (const id of [current, postImage, reported]) expect(await readMedia(db, id)).not.toBeNull();
  expect((await db.select().from(profiles).where(eq(profiles.userId, "writer")))[0].avatarMediaId).toBe(current);
  await db.update(reports).set({ status: "dismissed", handledAt: OLD }).where(eq(reports.id, report.id));
  await pruneIdentitySnapshots(db, NOW);
  expect(await readMedia(db, reported)).toBeNull();
  expect((await db.select().from(media).where(eq(media.id, reported)))[0]).toMatchObject({ bytes: null, deletedAt: NOW });
});

it("honors preservation and shutdown, and resumes orphan image removal after a deadline", async () => {
  const db = await world();
  await evidence(db, "avatar");
  await db.update(retentionHold).set({ active: true });
  expect(Object.values(await pruneIdentitySnapshots(db, NOW)).every(result => result.stop === "hold")).toBe(true);
  await db.update(retentionHold).set({ active: false });
  const signal = AbortSignal.abort();
  const stopped = await runMaintenanceCleanup(db, NOW, { signal });
  for (const category of ["identity_action_snapshots", "identity_report_snapshots", "identity_avatar_media"]) expect(stopped[category]).toMatchObject({ removed: 0, stop: "signal" });
  // End the shared deadline just before the media category's first transaction.
  let ticks = 0;
  const interrupted = await withRetentionRun({ clock: () => ++ticks < 6 ? 0 : 60_000 }, () => pruneIdentitySnapshots(db, NOW));
  expect(interrupted.identity_action_snapshots.removed).toBe(1);
  expect(interrupted.identity_report_snapshots.removed).toBe(1);
  expect(interrupted.identity_avatar_media).toMatchObject({ removed: 0, remaining: 1, stop: "time" });
  expect(await readMedia(db, imageId(1))).not.toBeNull();
  expect((await pruneIdentitySnapshots(db, NOW)).identity_avatar_media).toMatchObject({ removed: 1, remaining: 0, stop: "complete" });
});

it("caps a snapshot backlog and resumes it with at most 100 changed rows per transaction", { timeout: 60_000 }, async () => {
  const db = await world();
  const size = RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES;
  await db.insert(moderationActions).values(Array.from({ length: size + 7 }, () => ({ action: "clear_display_name", targetUserId: "writer", actorId: "operator", reason: "other", displayNamesBefore: names, createdAt: OLD })));
  await auditRetentionTransactions(db, [moderationActions]);
  const first = await pruneIdentitySnapshots(db, NOW);
  expect(first.identity_action_snapshots).toMatchObject({ removed: size, remaining: 7, batches: RETENTION_MAX_BATCHES, stop: "limit" });
  expect((await pruneIdentitySnapshots(db, NOW)).identity_action_snapshots).toMatchObject({ removed: 7, remaining: 0, stop: "complete" });
  expect(await db.select().from(moderationActions)).toHaveLength(size + 7);
  await expectBoundedTransactions(db, size + 7);
});

it.each(["avatar", "display_name"] as const)("allows a late %s appeal without restoring erased evidence", async kind => {
  const db = await world();
  const { action } = await evidence(db, kind);
  await pruneIdentitySnapshots(db, NOW);
  const filed = await createAppeal(db, "writer", action.id, "Late review");
  if (!filed.ok) throw Error(filed.error);
  expect(await getAppealableAction(db, "writer", action.id)).toMatchObject(kind === "avatar" ? { avatarUrl: null } : { displayNames: null });
  expect(await decideAppeal(db, { id: "reviewer", scope: { operator: true, langs: [] } }, filed.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ ok: true, reversed: false });
});

it.skipIf(!PG_MODE).each(["avatar", "display_name"] as const)("defers %s pruning while an appeal is being filed on another connection", { tags: ["postgres"] }, async kind => {
  const db = await world();
  const { action, report } = await evidence(db, kind);
  let enter!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const filing = db.transaction(async tx => {
    const result = await createAppeal(tx, "writer", action.id, "Pending review");
    enter(); await gate; return result;
  });
  await inside;
  try {
    const result = await pruneIdentitySnapshots(db, NOW);
    expect(result.identity_action_snapshots).toMatchObject({ removed: 0, remaining: 1, stop: "deferred" });
    expect(result.identity_report_snapshots).toMatchObject({ removed: 0, remaining: 1, stop: "deferred" });
  } finally { release(); }
  expect(await filing).toMatchObject({ ok: true });
  await pruneIdentitySnapshots(db, NOW);
  expect((await db.select().from(moderationActions))[0]).toEqual(action);
  expect((await db.select().from(reports))[0]).toEqual(report);
});

it.skipIf(!PG_MODE)("drains available copies past 101 locked action rows and resumes the deferred rows", { tags: ["postgres"] }, async () => {
  const db = await world();
  const actions = await db.insert(moderationActions).values(Array.from({ length: 451 }, () => ({ action: "clear_display_name", targetUserId: "writer", actorId: "operator", reason: "other", displayNamesBefore: names, createdAt: OLD }))).returning();
  let enter!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const held = db.transaction(async tx => {
    await tx.execute(sql`select id from moderation_actions where id <= ${actions[100].id} for update`);
    enter(); await gate;
  });
  await inside;
  try {
    expect((await pruneIdentitySnapshots(db, NOW)).identity_action_snapshots).toMatchObject({ removed: 350, remaining: 101, skipped: 101, stop: "deferred" });
  } finally { release(); await held; }
  expect((await pruneIdentitySnapshots(db, NOW)).identity_action_snapshots).toMatchObject({ removed: 101, remaining: 0, stop: "complete" });
});
