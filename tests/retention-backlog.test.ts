import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { aiQuestionReports, appeals, chatAccessLog, chatMessages, chatReportSnapshots, chatTranslationReports, invitationNoteTranslations, invitations, jobs, llmUsage, media, moderationActions, notifications, pushDeliveries, pushSubscriptions, oauthClient, oauthRefreshToken, rateLimits, reports, session, signingChallenges, suspendedEmailHashes, user, verification, villageReportSnapshots, villages } from "~/lib/db/schema";
import { runMaintenanceCleanup } from "~/lib/jobs/maintenance-jobs.server";
import { addMember, createTestDb } from "./helpers/db";
import { auditRetentionTransactions, expectBoundedTransactions } from "./helpers/retention";
import { pruneChatReportSnapshots } from "~/lib/village-chat-reports.server";
import type { RetentionResults } from "~/lib/retention-batch.server";
import { PG_MODE } from "./helpers/pg-test";

const NOW = new Date("2030-03-31T12:00:00Z");
const OLD = new Date("2028-01-01T00:00:00Z");
const SIZE = 350;
const each = <T>(make: (i: number) => T) => Array.from({ length: SIZE }, (_, i) => make(i));

it("drains every maintenance category's 350-row backlog within one invocation", { timeout: 30_000 }, async () => {
  const db = await createTestDb();
  await addMember(db, "a", "alice");
  const [village] = await db.insert(villages).values({ kind: "invite_public", name: "Retention fixture", slug: "retention-fixture" }).returning();
  await db.insert(aiQuestionReports).values(each(() => ({
    reporterId: "a", villageId: village.id, question: "Private question", createdAt: OLD,
    answer: {
      answer: { status: "answered" as const, readings: [{ text: "Private answer", citations: [] }], citations: [] },
      scope: { replies: 0, sources: 0, truncated: false }, language: "en" as const,
      engine: "fake", model: "fake-1", expiresAt: OLD.getTime() / 1000,
    },
  })));
  const villageReports = await db.insert(reports).values(each(() => ({ villageId: village.id, reporterId: "a", reason: "other", status: "resolved", handledAt: OLD }))).returning();
  await db.insert(villageReportSnapshots).values(villageReports.map(r => ({ reportId: r.id, name: "Private name", description: "Private description", slug: "old-name" })));
  const messageId = (i: number) => i.toString(16).padStart(32, "0");
  await db.insert(chatMessages).values(each(i => ({ id: messageId(i), villageId: village.id, authorId: "a", lang: "en", body: "Chat body", createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(reports).values(each(i => ({ chatMessageId: messageId(i), chatLang: "en", chatAuthorId: "a", reporterId: "a", reason: "other", status: "resolved", handledAt: OLD })));
  await db.insert(chatTranslationReports).values(each(i => ({ messageId: messageId(i), reporterId: "a", lang: "en", sourceLang: "en", sourceHash: "s", translationHash: `t${i}`, original: "Private original", translation: "Private translation", note: "Private note", createdSeq: i + 1, changedSeq: i + 1, status: "resolved" as const, handledAt: OLD })));
  await db.insert(chatReportSnapshots).values(each(i => ({ messageId: messageId(i), lang: "en", body: "Private evidence", authorHandle: "alice", messageCreatedAt: OLD, createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatAccessLog).values(each(() => ({ villageId: village.id, reportId: villageReports[0].id, readerId: "a", readerHandle: "alice", kind: "context", fromSeq: 0, toSeq: 0, ranges: [], versions: [], reason: "Review", createdAt: OLD })));
  await db.insert(rateLimits).values(each(i => ({ key: `r${i}`, windowStart: OLD, expiresAt: OLD, count: 1 })));
  await db.insert(verification).values(each(i => ({ id: `v${i}`, identifier: `v${i}`, value: "private", expiresAt: OLD })));
  await db.insert(session).values(each(i => ({ id: `s${i}`, token: `s${i}`, userId: "a", createdAt: OLD, updatedAt: OLD, expiresAt: OLD })));
  await db.insert(notifications).values(each(() => ({ userId: "a", kind: "mention", createdAt: OLD })));
  await db.insert(pushSubscriptions).values({ id: "retention-push", browserSecretHash: "fixture", userId: "a", vapidPublicKey: "fixture", browser: "Other", os: "Other", authorizingSessionId: "expired", authorizedUntil: OLD, stoppedReason: "member_stopped" });
  // Recent notices keep their finished deliveries out of notification cascades,
  // so this category must drain its own 350-row backlog in bounded batches.
  const recent = await db.insert(notifications).values(each(() => ({ userId: "a", kind: "mention", createdAt: NOW }))).returning({ id: notifications.id });
  await db.insert(pushDeliveries).values(recent.map(row => ({ notificationId: row.id, subscriptionId: "retention-push", generation: 1, userId: "a", createdAt: OLD, expiresAt: OLD, completedAt: OLD })));
  await db.insert(llmUsage).values(each(() => ({ engine: "fake", model: "m", purpose: "translate", createdAt: OLD })));
  await db.insert(signingChallenges).values(each(i => ({ challenge: `c${i}`, userId: "a", operation: "create-topic", payload: "private", payloadHash: "p", formHash: "f", createdAt: new Date(OLD.getTime() - 60_000), expiresAt: OLD })));
  await db.insert(jobs).values(each(() => ({ kind: "old", status: "done", updatedAt: OLD })));
  await db.insert(invitations).values(each(i => ({ id: `i${i}`, tokenHash: `h${i}`, email: "invitee@example.com", createdBy: "a", expiresAt: OLD, note: "Private invitation note", noteLang: "ja" })));
  await db.insert(invitationNoteTranslations).values(each(i => ({ invitationId: `i${i}`, lang: "en", state: "ready" as const, text: "Private translated note" })));
  await db.insert(jobs).values(each(i => ({ kind: "translate_invitation_note", status: "queued", payload: { invitationId: `i${i}`, lang: "en", paidTranslationCalls: { saved: "Private checkpoint" } } })));
  await db.insert(oauthClient).values(each(i => ({ id: `o${i}`, clientId: `o${i}`, redirectUris: [], createdAt: OLD })));
  // Keep this client out of unused-client retention so replay cleanup, rather
  // than the client's cascade, must clear all 350 stored answers itself.
  await db.insert(oauthClient).values({ id: "rotation-live", clientId: "rotation-live", redirectUris: [], createdAt: NOW });
  await db.insert(oauthRefreshToken).values(each(i => ({ id: `rotation-${i}`, token: `rotation-${i}`, clientId: "rotation-live", userId: "a", scopes: ["read"],
    createdAt: OLD, expiresAt: new Date(NOW.getTime() + 900_000), rotationReplayExpiresAt: OLD, rotationReplayResponse: "encrypted-fixture-answer" })));
  await db.insert(suspendedEmailHashes).values(each(i => ({ hash: `expired-hash-${i}`, expiresAt: OLD })));
  const imageId = (i: number) => i.toString(16).padStart(64, "0");
  await db.insert(media).values(each(i => ({ id: imageId(i), avatar: true, bytes: Buffer.from("image"), mime: "image/webp", width: 256, height: 256, byteSize: 5, uploadedBy: "a", uploadedAt: OLD })));
  await db.insert(reports).values(each(i => ({ avatarUserId: "a", avatarMediaId: imageId(i), reporterId: "a", reason: "other", status: "resolved", handledAt: OLD })));
  await db.insert(moderationActions).values(each(i => ({ action: "clear_avatar", targetUserId: "a", avatarMediaIdBefore: imageId(i), actorId: "a", reason: "other", createdAt: OLD })));
  const villageImageId = (i: number) => imageId(i + SIZE);
  await db.insert(media).values(each(i => ({ id: villageImageId(i), avatar: true, villageId: village.id, bytes: Buffer.from("image"), mime: "image/webp", width: 256, height: 256, byteSize: 5, uploadedBy: "a", uploadedAt: OLD })));
  for (const [i, report] of villageReports.entries()) await db.update(reports).set({ iconMediaId: villageImageId(i) }).where(eq(reports.id, report.id));
  await db.insert(moderationActions).values(each(i => ({ action: "clear_village_icon", targetVillageId: village.id, iconMediaIdBefore: villageImageId(i), actorId: "a", reason: "other", createdAt: OLD })));
  const tables = [aiQuestionReports, suspendedEmailHashes, rateLimits, verification, session, chatAccessLog, notifications, pushDeliveries, llmUsage, signingChallenges, jobs, villageReportSnapshots, chatReportSnapshots, chatTranslationReports, invitations, invitationNoteTranslations, oauthClient, oauthRefreshToken, moderationActions, reports, media];
  await auditRetentionTransactions(db, tables);

  const results = await runMaintenanceCleanup(db, NOW);

  for (const [category, result] of Object.entries(results)) {
    expect(result, category).toMatchObject({ removed: category === "entry_content" ? 0 : category === "identity_avatar_media" ? SIZE * 2 : SIZE, remaining: 0, stop: "complete" });
  }
  expect(Object.keys(results)).toHaveLength(tables.length + 6);
  expect((await db.select().from(oauthRefreshToken)).every(row => row.rotationReplayResponse === null)).toBe(true);
  // An invitation loses its recipient and then its note in separate batches.
  // Jobs include old finished rows, checkpoint redaction and queued-note removal.
  await expectBoundedTransactions(db, SIZE * (tables.length + 6));
  const { rows } = await db.execute(sql`select table_name, count(*)::int as changed from retention_changes group by table_name`) as { rows: { table_name: string; changed: number }[] };
  expect(rows).toHaveLength(tables.length);
  for (const row of rows) expect(row.changed, row.table_name).toBe(SIZE * (row.table_name === "jobs" ? 3 : ["invitations", "reports", "moderation_actions", "media"].includes(row.table_name) ? 2 : 1));
});

it("drains automated chat evidence and assessment copies without protected cases filling the batch", { timeout: 30_000 }, async () => {
  const db = await createTestDb();
  await addMember(db, "a", "alice");
  const [village] = await db.insert(villages).values({ kind: "invite_public", name: "Automated cases", slug: "automated-cases" }).returning();
  const protectedCount = 101;
  const rows = Array.from({ length: protectedCount + SIZE }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), villageId: village.id, authorId: "a", lang: "en", body: "Private chat", hiddenAt: OLD, createdSeq: i + 1, changedSeq: i + 1 }));
  await db.insert(chatMessages).values(rows);
  await db.insert(chatReportSnapshots).values(rows.map(row => ({ messageId: row.id, lang: "en", body: "Private evidence", authorHandle: "alice", messageCreatedAt: OLD, createdSeq: row.createdSeq, changedSeq: row.changedSeq })));
  const actions = await db.insert(moderationActions).values(rows.map(row => ({ action: "hide_chat", targetChatMessageId: row.id, actorId: null, reason: "spam", automatic: true, createdAt: OLD }))).returning();
  await db.insert(appeals).values(actions.slice(0, protectedCount).map(action => ({ actionId: action.id, appellantId: "a", text: "Pending review" })));
  await db.insert(user).values(Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, name: "", email: `r${i}@example.com` })));
  await db.insert(reports).values(Array.from({ length: 101 }, (_, i) => ({ chatMessageId: rows[protectedCount].id, chatLang: "en", chatAuthorId: "a", reporterId: `r${i}`, reason: "other", status: "resolved", handledAt: OLD, aiAssessment: { en: "Private assessment", ja: "Private assessment" } })));
  await auditRetentionTransactions(db, [chatReportSnapshots, reports]);
  const results: RetentionResults = {};
  expect(await pruneChatReportSnapshots(db, NOW, results)).toBe(SIZE);
  expect(results.chat_report_snapshots).toMatchObject({ removed: SIZE + 101, remaining: 0, stop: "complete" });
  const snapshots = await db.select().from(chatReportSnapshots).orderBy(chatReportSnapshots.messageId);
  expect(snapshots.slice(0, protectedCount).every(row => row.body === "Private evidence" && row.prunedAt === null)).toBe(true);
  expect(snapshots.slice(protectedCount).every(row => row.body === null && row.prunedAt?.getTime() === NOW.getTime())).toBe(true);
  expect((await db.select().from(reports)).every(row => row.aiAssessment === null)).toBe(true);
  await expectBoundedTransactions(db, SIZE + 101);
});

it.skipIf(!PG_MODE)("drains available chat snapshots past a locked assessment, then resumes its dependent snapshot", { tags: ["postgres"] }, async () => {
  const db = await createTestDb();
  await addMember(db, "a", "alice");
  const [village] = await db.insert(villages).values({ kind: "invite_public", name: "Locked assessment", slug: "locked-assessment" }).returning();
  const [message] = await db.insert(chatMessages).values({ id: "0".repeat(32), villageId: village.id, authorId: "a", lang: "en", body: "Private chat", createdSeq: 1, changedSeq: 1 }).returning();
  await db.insert(chatReportSnapshots).values({ messageId: message.id, lang: "en", body: "Private evidence", authorHandle: "alice", messageCreatedAt: OLD, createdSeq: 1, changedSeq: 1 });
  const [report] = await db.insert(reports).values({ chatMessageId: message.id, chatLang: "en", chatAuthorId: "a", reporterId: "a", reason: "other", status: "resolved", handledAt: OLD, aiAssessment: { en: "Private assessment", ja: "Private assessment" } }).returning();
  const available = each(i => ({ id: (i + 1).toString(16).padStart(32, "0"), villageId: village.id, authorId: "a", lang: "en", body: "Private chat", createdSeq: i + 2, changedSeq: i + 2 }));
  await db.insert(chatMessages).values(available);
  await db.insert(chatReportSnapshots).values(available.map(row => ({ messageId: row.id, lang: "en", body: "Private evidence", authorHandle: "alice", messageCreatedAt: OLD, createdSeq: row.createdSeq, changedSeq: row.changedSeq })));
  await db.insert(reports).values(available.map(row => ({ chatMessageId: row.id, chatLang: "en", chatAuthorId: "a", reporterId: "a", reason: "other", status: "resolved", handledAt: OLD })));
  await auditRetentionTransactions(db, [chatReportSnapshots, reports]);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const held = db.transaction(async tx => {
    await tx.select().from(reports).where(eq(reports.id, report.id)).for("update");
    entered(); await gate;
  });
  await inside;
  try {
    const result: RetentionResults = {};
    expect(await pruneChatReportSnapshots(db, NOW, result)).toBe(SIZE);
    expect(result.chat_report_snapshots).toMatchObject({ removed: SIZE, remaining: 2, skipped: 2, stop: "deferred" });
    expect((await db.select().from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, message.id)))[0].body).toBe("Private evidence");
    await expectBoundedTransactions(db, SIZE);
  } finally { release(); await held; }
  expect(await pruneChatReportSnapshots(db, NOW)).toBe(1);
  expect((await db.select().from(reports).where(eq(reports.id, report.id)))[0].aiAssessment).toBeNull();
});
