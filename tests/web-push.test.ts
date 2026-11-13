import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { entries, jobs, notifications, profiles, pushDeliveries, pushSubscriptions, session, user, villageMembers, villages, chatConsents, chatMessages } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { enqueuePush, SEND_PUSH_JOB } from "~/lib/push/enqueue.server";
import { currentPushId, ownPushSubscriptions, reconcilePush, registerPush, stopPush } from "~/lib/push/subscriptions.server";
import { createPushHandlers } from "~/lib/jobs/push-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { pushOpeningIds } from "~/lib/push/opening.server";
import { pushMessage } from "~/lib/push/messages.server";
import { buildMemberExport, MEMBER_EXPORT_VERSION } from "~/lib/exports.server";
import { addMember, createTestDb } from "./helpers/db";
import { configurePush, identity, pushAuthorization, subscription } from "./helpers/push";
import type { PushSendResult } from "~/lib/push/send.server";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

beforeEach(() => { configurePush(); });
afterEach(() => { vi.unstubAllEnvs(); });
async function fixture() {
  const db = await createTestDb();
  await addMember(db, "push_reader", "push_reader", { homeArea: "en" }); await addMember(db, "push_author", "push_author", { homeArea: "en" });
  await db.update(profiles).set({ emailPref: "none", uiLocale: "en" }).where(eq(profiles.userId, "push_reader"));
  const browser = identity(); const sub = subscription(); const authorization = await pushAuthorization(db, "push_reader");
  await registerPush(db, "push_reader", browser, sub, "Mozilla/5.0 (iPhone) Version/17 Safari/605", authorization);
  const topic = await createTopic(db, "push_reader", { lang: "en", title: "Private title marker", body: "Private topic body" }); if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(db, "push_author", topic.id, { lang: "en", body: "Private reply marker" }); if (!reply.ok) throw new Error(reply.error);
  const [notice] = await db.select().from(notifications).where(eq(notifications.userId, "push_reader"));
  const [delivery] = await db.select().from(pushDeliveries);
  const now = new Date(Date.now() + 61_000);
  return { db, browser, sub, authorization, topic: topic.id, reply: reply.id, notice, delivery, now };
}

it("registers independently of sessions, caps active registrations and protects browser ownership", async () => {
  const f = await fixture();
  const same = await registerPush(f.db, "push_reader", f.browser, f.sub, "Chrome/1 Linux", f.authorization);
  expect(same.generation).toBe(1);
  await expect(registerPush(f.db, "push_author", { ...f.browser, secret: identity().secret }, f.sub, "", f.authorization)).rejects.toMatchObject({ code: "conflict" });
  await expect(registerPush(f.db, "push_author", identity(), f.sub, "", f.authorization)).rejects.toMatchObject({ code: "conflict" });
  expect(await currentPushId(f.db, "push_author", f.browser)).toBeNull();
  for (let i = 1; i < 10; i++) await registerPush(f.db, "push_reader", identity(), subscription(), "Firefox/1 Linux", f.authorization);
  await expect(registerPush(f.db, "push_reader", identity(), subscription(), "", f.authorization)).rejects.toMatchObject({ code: "limit" });
  const labels = await ownPushSubscriptions(f.db, "push_reader");
  expect(labels).toHaveLength(10); expect(JSON.stringify(labels)).not.toContain(f.sub.endpoint); expect(JSON.stringify(labels)).not.toContain(f.browser.secret);
});
it("invalidates old-account generations and requires explicit activation for the next account", async () => {
  const f = await fixture(); const otherAuth = await pushAuthorization(f.db, "push_author");
  expect(await reconcilePush(f.db, "push_author", f.browser, otherAuth)).toBeNull();
  const [stopped] = await f.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, f.browser.id));
  expect(stopped.userId).toBe("push_reader"); expect(stopped.stoppedReason).toBe("account_changed"); expect(stopped.generation).toBe(2);
  await registerPush(f.db, "push_author", f.browser, f.sub, "Chrome/1 Android", otherAuth);
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  expect(send).not.toHaveBeenCalled();
  const [owner] = await f.db.select().from(pushSubscriptions); expect(owner.userId).toBe("push_author"); expect(owner.generation).toBe(3);
});
it("queues deliveries atomically and keeps dedupe after a job has completed", async () => {
  const f = await fixture();
  await enqueuePush(f.db, [{ id: f.notice.id, userId: "push_reader", kind: "reply_to_topic" }]);
  expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  await expect(f.db.transaction(async tx => {
    const [notice] = await tx.insert(notifications).values({ userId: "push_reader", kind: "mention", threadId: f.topic, entryId: f.reply }).returning();
    await enqueuePush(tx, [{ ...notice, kind: "mention" }]); throw new Error("rollback producer");
  })).rejects.toThrow("rollback producer");
  expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  const send = vi.fn(async () => ({ kind: "accepted" as const })); await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  await enqueuePush(f.db, [{ id: f.notice.id, userId: "push_reader", kind: "reply_to_topic" }]);
  expect(await f.db.select().from(pushDeliveries)).toHaveLength(1); expect(await f.db.select().from(jobs).where(eq(jobs.kind, SEND_PUSH_JOB))).toHaveLength(1);
});
it("coalesces a topic and opens a permission-filtered group without publishing content to providers", async () => {
  const f = await fixture(); await createReply(f.db, "push_author", f.topic, { lang: "en", body: "Another private reply" });
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  const stats = await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  expect(stats.failed).toBe(0); expect(send).toHaveBeenCalledTimes(1);
  const args = send.mock.calls[0] as unknown as [unknown, string, { ttl: number; topic: string }];
  const payload = JSON.parse(args[1]); expect(payload.title).toBe("tomola"); expect(payload.url).toBe(`/notifications?push=${f.delivery.id}`);
  expect(args[1]).not.toMatch(/Private|push_author|push_reader/); expect(args[2].ttl).toBeLessThanOrEqual(7200); expect(payload.tag).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(await pushOpeningIds(f.db, "push_reader", String(f.delivery.id))).toHaveLength(2);
  expect(await pushOpeningIds(f.db, "push_author", String(f.delivery.id))).toBeNull();
  await f.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, f.topic));
  expect(await pushOpeningIds(f.db, "push_reader", String(f.delivery.id))).toBeNull();
  expect((await f.db.select().from(notifications).where(eq(notifications.id, f.notice.id)))[0].readAt).toBeNull();
});
it.each(["read", "hidden", "deleted", "stopped", "session", "authorization", "generation", "recipient", "suspended", "expiry"])("rechecks %s immediately before sending", async condition => {
  const f = await fixture();
  if (condition === "read") await f.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, f.notice.id));
  if (condition === "hidden") await f.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, f.reply));
  if (condition === "deleted") await f.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, f.topic));
  if (condition === "stopped") await stopPush(f.db, "push_reader", f.browser.id);
  if (condition === "session") await f.db.delete(session).where(eq(session.id, f.authorization.sessionId));
  if (condition === "authorization") await f.db.update(pushSubscriptions).set({ authorizedUntil: new Date(0) });
  if (condition === "generation") await f.db.update(pushSubscriptions).set({ generation: 9 });
  if (condition === "recipient") await f.db.update(pushSubscriptions).set({ userId: "push_author" });
  if (condition === "suspended") await f.db.update(profiles).set({ suspendedUntil: new Date(f.now.getTime() + 86400000) }).where(eq(profiles.userId, "push_reader"));
  if (condition === "expiry") f.now = new Date(f.now.getTime() + 7200000);
  const send = vi.fn(async () => ({ kind: "accepted" as const })); await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now }); expect(send).not.toHaveBeenCalled();
});
it.each(["gone", "retry", "operator"] as const)("handles %s without exposing endpoints in queue evidence", async kind => {
  const f = await fixture();
  const send = vi.fn(async (): Promise<PushSendResult> => ({ kind, retryAfterSeconds: 123 }));
  const logger = { error: vi.fn(), warn: vi.fn() };
  const stats = await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now, logger });
  const [row] = await f.db.select().from(pushSubscriptions); const [job] = await f.db.select().from(jobs).where(eq(jobs.kind, SEND_PUSH_JOB));
  expect(row.stoppedReason).toBe(kind === "gone" ? "expired" : null);
  if (kind === "retry") { expect(stats.deferred).toBe(1); expect(job.runAt.getTime()).toBeGreaterThanOrEqual(f.now.getTime() + 123000); expect(job.runAt.getTime()).toBeLessThan(f.now.getTime() + 124000); }
  if (kind === "operator") { expect(stats.failed).toBe(1); expect(job.lastError).toContain("VAPID"); }
  expect(JSON.stringify([job.lastError, logger.error.mock.calls])).not.toContain(f.sub.endpoint); expect(JSON.stringify([job.lastError, logger.error.mock.calls])).not.toContain(f.sub.keys.auth);
});
it("defers at the member rate cap and preserves registrations across VAPID mistakes", async () => {
  const f = await fixture(); const { hitMemberLimit } = await import("~/lib/rate-limit.server");
  for (let i = 0; i < 60; i++) await hitMemberLimit(f.db, "push-send", "push_reader", f.now);
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  const stats = await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now }); expect(stats.deferred).toBe(1); expect(send).not.toHaveBeenCalled();
  configurePush(); await f.db.update(jobs).set({ runAt: f.now }).where(eq(jobs.kind, SEND_PUSH_JOB));
  await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  const [row] = await f.db.select().from(pushSubscriptions);
  expect(row.stoppedReason).toBeNull(); expect(row.generation).toBe(1); expect(row.endpoint).toBe(f.sub.endpoint);
  expect((await f.db.select().from(pushDeliveries))[0].completedAt).not.toBeNull();
});
it("exports only counts and coarse labels and cascades registrations on deletion", async () => {
  const f = await fixture(); const exported = await buildMemberExport(f.db, "push_reader");
  expect(exported.version).toBe(MEMBER_EXPORT_VERSION); expect(exported.push_subscriptions.count).toBe(1);
  const text = JSON.stringify(exported.push_subscriptions); for (const secret of [f.sub.endpoint, f.sub.keys.auth, f.sub.keys.p256dh, f.browser.secret]) expect(text).not.toContain(secret);
  await addMember(f.db, "push_delete", "push_delete"); const auth = await pushAuthorization(f.db, "push_delete");
  await registerPush(f.db, "push_delete", identity(), subscription(), "Chrome Linux", auth);
  await f.db.delete(user).where(eq(user.id, "push_delete")); expect(await f.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, "push_delete"))).toHaveLength(0);
});
it("keeps the switch closed independently of email settings and localizes generic messages", async () => {
  const f = await fixture(); vi.stubEnv("WEB_PUSH", "");
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "Closed push" }); expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  const send = vi.fn(async () => ({ kind: "accepted" as const })); await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now }); expect(send).not.toHaveBeenCalled();
  const { jsonMessages } = await import("./helpers/messages-json");
  expect(pushMessage("reply_to_topic", "ja")).toBe(jsonMessages().push_message_reply({}, { locale: "ja" })); expect(pushMessage("reply_to_topic", "en")).toBe(jsonMessages().push_message_reply({}, { locale: "en" }));
});


it.each(["membership", "consent", "author", "hidden", "unaddressable"])("rechecks chat %s with the mail permission boundary", async condition => {
  const f = await fixture();
  await f.db.delete(pushDeliveries);
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const [village] = await f.db.insert(villages).values({ slug: "push-chat", name: "Private village marker", kind: "open" }).returning();
  await f.db.insert(villageMembers).values(["push_reader", "push_author"].map(userId => ({ userId, villageId: village.id, role: userId === "push_author" ? "owner" : "member" })));
  await (await import("./helpers/chat-consent")).consentChatMembers(f.db);
  await (await import("~/lib/village-chat.server")).mutateChat(f.db, "push_author", "push-chat", "send", { body: "@push_reader private chat marker" });
  expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  if (condition === "membership") await f.db.delete(villageMembers).where(eq(villageMembers.userId, "push_reader"));
  if (condition === "consent") await f.db.delete(chatConsents).where(eq(chatConsents.userId, "push_reader"));
  if (condition === "author") await f.db.update(profiles).set({ suspendedUntil: new Date(f.now.getTime() + 86400000) }).where(eq(profiles.userId, "push_author"));
  if (condition === "hidden") await f.db.update(chatMessages).set({ hiddenAt: new Date() });
  if (condition === "unaddressable") await f.db.update(villages).set({ slug: null }).where(eq(villages.id, village.id));
  const send = vi.fn(async () => ({ kind: "accepted" as const })); await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now }); expect(send).not.toHaveBeenCalled();
});


it("does not fold an older deferred notice into a new delivery window", async () => {
  const f = await fixture();
  await f.db.update(pushDeliveries).set({ createdAt: new Date(Date.now() - 120000) }).where(eq(pushDeliveries.id, f.delivery.id));
  await f.db.update(jobs).set({ runAt: new Date(f.now.getTime() + 120000) }).where(eq(jobs.kind, SEND_PUSH_JOB));
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "Fresh reply" });
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  expect(send).toHaveBeenCalledTimes(1);
  const body = JSON.parse((send.mock.calls[0] as unknown as [unknown, string])[1]);
  expect(body.url).toMatch(/^\/notifications\/\d+\/open\?push=/);
  expect((await f.db.select().from(pushDeliveries).where(eq(pushDeliveries.id, f.delivery.id)))[0].completedAt).toBeNull();
});


it("keeps coalesced peers under one leader through temporary failure and retry", async () => {
  const f = await fixture();
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "A second reply" });
  const send = vi.fn().mockResolvedValueOnce({ kind: "retry", retryAfterSeconds: 120 }).mockResolvedValue({ kind: "accepted" });
  const first = await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  expect(first.deferred).toBe(2); expect(send).toHaveBeenCalledTimes(1);
  const deliveries = await f.db.select().from(pushDeliveries);
  expect(deliveries.every(row => row.batchId === f.delivery.id && row.completedAt === null)).toBe(true);
  await runDueJobs(f.db, createPushHandlers({ send }), { now: new Date(f.now.getTime() + 121000) });
  expect(send).toHaveBeenCalledTimes(2);
  expect((await f.db.select().from(pushDeliveries)).every(row => row.completedAt !== null)).toBe(true);
  expect(await pushOpeningIds(f.db, "push_reader", String(f.delivery.id))).toHaveLength(2);
});
it("uses the surviving peer kind for a single valid notification", async () => {
  const f = await fixture();
  await f.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, f.notice.id));
  const [peer] = await f.db.insert(notifications).values({ userId: "push_reader", kind: "mention", actorId: "push_author", threadId: f.topic, entryId: f.reply }).returning();
  await enqueuePush(f.db, [{ ...peer, kind: "mention" }]);
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  const message = JSON.parse((send.mock.calls[0] as unknown as [unknown, string])[1]);
  expect(message.body).toBe(pushMessage("mention", "en"));
});
it("rejects delivery IDs outside the PostgreSQL integer range without querying", async () => {
  const f = await fixture(); const select = vi.spyOn(f.db, "select");
  for (const value of ["2147483648", "9999999999", "10000000000", "0", "-1"]) expect(await pushOpeningIds(f.db, "push_reader", value)).toBeNull();
  expect(select).not.toHaveBeenCalled(); select.mockRestore();
});
it("erases delivery secrets immediately when a registration stops", async () => {
  const f = await fixture(); await stopPush(f.db, "push_reader", f.browser.id);
  const [row] = await f.db.select().from(pushSubscriptions);
  expect(row).toMatchObject({ endpoint: null, p256dh: null, auth: null, generation: 2, browser: "Safari", os: "iOS" });
  expect(row.createdAt).toBeInstanceOf(Date);
  expect(await registerPush(f.db, "push_reader", f.browser, f.sub, "Safari iPhone", f.authorization)).toMatchObject({ generation: 3 });
});

it.each(["pending", "failed"])("stops reactivated registrations when revising a %s deletion request", async state => {
  const f = await fixture();
  const { requestAccountDeletion } = await import("~/lib/account-delete.server");
  const { accountDeletions } = await import("~/lib/db/schema");
  const id = await requestAccountDeletion(f.db, "push_reader", { confirmation: "push_reader" });
  await f.db.update(accountDeletions).set({ state }).where(eq(accountDeletions.id, id));
  await registerPush(f.db, "push_reader", f.browser, f.sub, "Chrome Linux", f.authorization);
  expect(await requestAccountDeletion(f.db, "push_reader", { confirmation: "push_reader" })).toBe(id);
  expect((await f.db.select().from(pushSubscriptions))[0]).toMatchObject({ stoppedReason: "account_deletion", endpoint: null });
});
it("retains recent or pending deliveries and expires finished records after thirty days", async () => {
  const f = await fixture();
  const { runRetentionCleanup } = await import("~/lib/retention.server");
  await f.db.update(pushDeliveries).set({ completedAt: f.now });
  const cutoff = new Date(f.now.getTime() + 30 * 86400000);
  await runRetentionCleanup(f.db, cutoff); expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  await f.db.update(pushDeliveries).set({ completedAt: null });
  await runRetentionCleanup(f.db, new Date(cutoff.getTime() + 1)); expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  await f.db.update(pushDeliveries).set({ completedAt: f.now });
  await runRetentionCleanup(f.db, new Date(cutoff.getTime() + 1)); expect(await f.db.select().from(pushDeliveries)).toHaveLength(0);
});

it.each(["accepted", "gone", "retry"] as const)("ignores a stale %s response after the registration generation changes", async kind => {
  const f = await fixture();
  const send = vi.fn(async () => {
    await stopPush(f.db, "push_reader", f.browser.id);
    await registerPush(f.db, "push_reader", f.browser, f.sub, "Chrome Linux", f.authorization);
    return { kind };
  });
  const result = await runDueJobs(f.db, createPushHandlers({ send }), { now: f.now });
  expect(result.deferred).toBe(0);
  expect((await f.db.select().from(pushSubscriptions))[0]).toMatchObject({ generation: 3, stoppedReason: null, lastAcceptedAt: null, failures: 0 });
  expect((await f.db.select().from(pushDeliveries))[0].completedAt).not.toBeNull();
});

it.each(["delete", "report", "automatic"] as const)("recovers chat peers after %s removes their deferred leader", async removal => {
  const f = await fixture();
  await f.db.delete(pushDeliveries);
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const [village] = await f.db.insert(villages).values({ slug: "push-orphan", name: "Chat recovery", kind: "open" }).returning();
  await f.db.insert(villageMembers).values(["push_reader", "push_author"].map(userId => ({ userId, villageId: village.id, role: "member" })));
  await (await import("./helpers/chat-consent")).consentChatMembers(f.db);
  const { mutateChat } = await import("~/lib/village-chat.server");
  const leader = await mutateChat(f.db, "push_author", "push-orphan", "send", { body: "@push_reader first mention" });
  await f.db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, leader.id));
  await mutateChat(f.db, "push_author", "push-orphan", "send", { body: "@push_reader surviving mention" });
  const send = vi.fn().mockResolvedValueOnce({ kind: "retry", retryAfterSeconds: 120 }).mockResolvedValue({ kind: "accepted" });
  const handlers = createPushHandlers({ send });
  const now = new Date(Date.now() + 61000);
  expect((await runDueJobs(f.db, handlers, { now })).deferred).toBe(2);
  const [first, peer] = await f.db.select().from(pushDeliveries).orderBy(pushDeliveries.id);
  expect(peer.batchId).toBe(first.id);
  if (removal === "delete") await mutateChat(f.db, "push_author", "push-orphan", "delete", { id: leader.id });
  if (removal === "report") {
    const { createChatReport, moderateChatReport } = await import("~/lib/village-chat-reports.server");
    await addMember(f.db, "push_moderator", "push_moderator");
    const report = await createChatReport(f.db, "push_reader", { slug: "push-orphan", messageId: leader.id, reason: "spam" });
    await moderateChatReport(f.db, { id: "push_moderator", scope: { operator: false, langs: ["en"] } }, { reportId: report.id, intent: "hide", reason: "spam", note: "Spam" });
  }
  if (removal === "automatic") {
    vi.stubEnv("MODERATION_SPAM_ENABLED", "1");
    const body = "@push_reader buy now https://a.example https://b.example https://c.example https://d.example";
    await f.db.update(chatMessages).set({ body }).where(eq(chatMessages.id, leader.id));
    const [message] = await f.db.select().from(chatMessages).where(eq(chatMessages.id, leader.id));
    expect(await f.db.transaction(tx => import("~/lib/moderation-automation.server").then(({ inspectChatSpam }) => inspectChatSpam(tx, message, new Date())))).toBe(true);
  }
  expect(await f.db.select().from(pushDeliveries).where(eq(pushDeliveries.id, first.id))).toHaveLength(0);
  await runDueJobs(f.db, handlers, { now: new Date(now.getTime() + 61000) });
  expect(send).toHaveBeenCalledTimes(2);
  const [survivor] = await f.db.select().from(pushDeliveries);
  expect(survivor).toMatchObject({ id: peer.id, batchId: peer.id }); expect(survivor.completedAt).not.toBeNull();
  expect(await pushOpeningIds(f.db, "push_reader", String(peer.id))).toEqual([peer.notificationId]);
});

it.each(["expired", "read", "session", "completed"])("ends or rechecks an orphaned peer when %s", async condition => {
  const f = await fixture();
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "Surviving reply" });
  const send = vi.fn().mockResolvedValueOnce({ kind: "retry", retryAfterSeconds: 120 }).mockResolvedValue({ kind: "accepted" });
  const handlers = createPushHandlers({ send });
  await runDueJobs(f.db, handlers, { now: f.now });
  const [leader, peer] = await f.db.select().from(pushDeliveries).orderBy(pushDeliveries.id);
  if (condition === "completed") await f.db.update(pushDeliveries).set({ completedAt: f.now }).where(eq(pushDeliveries.id, leader.id));
  else await f.db.delete(notifications).where(eq(notifications.id, leader.notificationId));
  if (condition === "read") await f.db.update(notifications).set({ readAt: f.now }).where(eq(notifications.id, peer.notificationId));
  if (condition === "session") await f.db.delete(session).where(eq(session.id, f.authorization.sessionId));
  const now = condition === "expired" ? new Date(peer.expiresAt.getTime() + 1) : new Date(f.now.getTime() + 61000);
  await runDueJobs(f.db, handlers, { now });
  expect(send).toHaveBeenCalledTimes(condition === "completed" ? 2 : 1);
  expect((await f.db.select().from(pushDeliveries).where(eq(pushDeliveries.id, peer.id)))[0].completedAt).not.toBeNull();
});

it("expires a peer at its own deadline while its leader is still deferred", async () => {
  const f = await fixture();
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "Short lived peer" });
  const send = vi.fn(async () => ({ kind: "retry" as const, retryAfterSeconds: 120 }));
  const handlers = createPushHandlers({ send });
  await runDueJobs(f.db, handlers, { now: f.now });
  const [, peer] = await f.db.select().from(pushDeliveries).orderBy(pushDeliveries.id);
  const expiresAt = new Date(f.now.getTime() + 70000);
  await f.db.update(pushDeliveries).set({ expiresAt }).where(eq(pushDeliveries.id, peer.id));
  await runDueJobs(f.db, handlers, { now: new Date(f.now.getTime() + 61000) });
  const [job] = await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `push:${peer.notificationId}:${peer.subscriptionId}:${peer.generation}`));
  expect(job.runAt).toEqual(expiresAt);
  await runDueJobs(f.db, handlers, { now: expiresAt });
  expect(send).toHaveBeenCalledOnce();
  expect((await f.db.select().from(pushDeliveries).where(eq(pushDeliveries.id, peer.id)))[0].completedAt).not.toBeNull();
});

it("does not enqueue deliveries for registrations awaiting a VAPID reconnect", async () => {
  const f = await fixture();
  configurePush();
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "After key rotation" });
  expect(await f.db.select().from(pushDeliveries)).toHaveLength(1);
  expect(await f.db.select().from(jobs).where(eq(jobs.kind, SEND_PUSH_JOB))).toHaveLength(1);
  await registerPush(f.db, "push_reader", f.browser, f.sub, "Chrome Linux", f.authorization);
  await createReply(f.db, "push_author", f.topic, { lang: "en", body: "After reconnect" });
  expect(await f.db.select().from(pushDeliveries)).toHaveLength(2);
});
