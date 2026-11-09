import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "~/lib/db/schema";
import { registerPush, stopPush } from "~/lib/push/subscriptions.server";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { configurePush, identity, pushAuthorization, subscription } from "./helpers/push";

describe.skipIf(!PG_MODE)("Web Push registration concurrency", { tags: ["postgres"] }, () => {
  beforeEach(() => { configurePush(); }); afterEach(() => { vi.unstubAllEnvs(); });
  it("serializes the member cap on independent PostgreSQL connections", async () => {
    const db = await createTestDb(); await addMember(db, "push_race", "push_race"); const auth = await pushAuthorization(db, "push_race");
    for (let i = 0; i < 9; i++) await registerPush(db, "push_race", identity(), subscription(), "Chrome Linux", auth);
    const results = await Promise.allSettled([registerPush(db, "push_race", identity(), subscription(), "Chrome Linux", auth), registerPush(db, "push_race", identity(), subscription(), "Chrome Linux", auth)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(await db.select().from(pushSubscriptions)).toHaveLength(10);
  });
  it("makes stopping wait for an in-flight registration lock and advances the generation", async () => {
    const db = await createTestDb(); await addMember(db, "push_stop_race", "push_stop_race"); const auth = await pushAuthorization(db, "push_stop_race"); const browser = identity();
    await registerPush(db, "push_stop_race", browser, subscription(), "Chrome Linux", auth);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let locked!: () => void; const ready = new Promise<void>(resolve => { locked = resolve; });
    const sending = db.transaction(async tx => { await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, browser.id)).for("update"); locked(); await held; });
    await ready; let stopped = false; const stopping = stopPush(db, "push_stop_race", browser.id).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(stopped).toBe(false); release(); await Promise.all([sending, stopping]);
    const [row] = await db.select().from(pushSubscriptions); expect(row.generation).toBe(2); expect(row.stoppedReason).toBe("member_stopped");
  });
});

it.skipIf(!PG_MODE).each(["accepted", "gone", "retry"] as const)("releases all database locks during %s transport and lets a stop win", { tags: ["postgres"] }, async kind => {
  configurePush();
  try {
    const { createTopic, createReply } = await import("~/lib/entries.server");
    const { createPushHandlers } = await import("~/lib/jobs/push-jobs.server");
    const { pushDeliveries, profiles, jobs } = await import("~/lib/db/schema");
    const { hitMemberLimit } = await import("~/lib/rate-limit.server");
    const db = await createTestDb();
    await addMember(db, "push_network", "push_network"); await addMember(db, "push_writer", "push_writer");
    const auth = await pushAuthorization(db, "push_network"); const browser = identity();
    await registerPush(db, "push_network", browser, subscription(), "Chrome Linux", auth);
    const topic = await createTopic(db, "push_network", { lang: "en", title: "Transport race", body: "Topic" }); if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(db, "push_writer", topic.id, { lang: "en", body: "Reply" }); if (!reply.ok) throw new Error(reply.error);
    const [delivery] = await db.select().from(pushDeliveries);
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, "send_push"));
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const sending = new Promise<void>(resolve => { started = resolve; });
    const send = vi.fn(async () => { started(); await held; return { kind }; });
    const handler = createPushHandlers({ send }).send_push;
    const now = new Date(Date.now() + 61000);
    const work = handler(job, { db, now });
    try {
      await sending;
      let timer!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          Promise.all([
            stopPush(db, "push_network", browser.id),
            db.update(profiles).set({ uiLocale: "ja" }).where(eq(profiles.userId, "push_network")),
            hitMemberLimit(db, "push-send", "push_network", now),
          ]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Transport held a database lock")), 1500); }),
        ]);
      } finally { clearTimeout(timer); }
    } finally { release(); await work; }
    const [row] = await db.select().from(pushSubscriptions);
    expect(row).toMatchObject({ generation: 2, stoppedReason: "member_stopped", lastAcceptedAt: null, failures: 0, endpoint: null });
    expect((await db.select().from(pushDeliveries).where(eq(pushDeliveries.id, delivery.id)))[0].completedAt).not.toBeNull();
    await handler(job, { db, now }); expect(send).toHaveBeenCalledOnce();
  } finally { vi.unstubAllEnvs(); }
});

it.skipIf(!PG_MODE)("serializes competing reservations after a leader notification is deleted", { tags: ["postgres"] }, async () => {
  configurePush();
  try {
    const { createTopic, createReply } = await import("~/lib/entries.server");
    const { createPushHandlers } = await import("~/lib/jobs/push-jobs.server");
    const { pushDeliveries, notifications, jobs } = await import("~/lib/db/schema");
    const db = await createTestDb();
    await addMember(db, "push_orphan", "push_orphan"); await addMember(db, "push_writer", "push_writer");
    const browser = identity();
    await registerPush(db, "push_orphan", browser, subscription(), "Chrome Linux", await pushAuthorization(db, "push_orphan"));
    const topic = await createTopic(db, "push_orphan", { lang: "en", title: "Orphan race", body: "Topic" }); if (!topic.ok) throw new Error(topic.error);
    for (const body of ["First reply", "Second reply"]) {
      const reply = await createReply(db, "push_writer", topic.id, { lang: "en", body }); if (!reply.ok) throw new Error(reply.error);
    }
    const [leader, peer] = await db.select().from(pushDeliveries).orderBy(pushDeliveries.id);
    const queued = await db.select().from(jobs).where(eq(jobs.kind, "send_push"));
    const leaderJob = queued.find(job => (job.payload as { deliveryId: number }).deliveryId === leader.id)!;
    const peerJob = queued.find(job => (job.payload as { deliveryId: number }).deliveryId === peer.id)!;
    const send = vi.fn().mockResolvedValueOnce({ kind: "retry", retryAfterSeconds: 120 }).mockResolvedValue({ kind: "accepted" });
    const handler = createPushHandlers({ send }).send_push;
    const now = new Date(Date.now() + 61000);
    await expect(handler(leaderJob, { db, now })).rejects.toMatchObject({ name: "DeferJob" });
    await db.delete(notifications).where(eq(notifications.id, leader.notificationId));
    const outcomes = await Promise.allSettled([handler(peerJob, { db, now }), handler(peerJob, { db, now })]);
    for (const result of outcomes) if (result.status === "rejected") expect(result.reason).toMatchObject({ name: "DeferJob" });
    expect(send).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(pushDeliveries);
    expect(row.id).toBe(peer.id); expect(row.completedAt).not.toBeNull();
  } finally { vi.unstubAllEnvs(); }
});
