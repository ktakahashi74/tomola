import { expect, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { addMember, createTestDb } from "./db";
import { createTopic } from "~/lib/entries.server";
import type { Db } from "~/lib/db/client.server";
import { jobs, nushiRequests, profiles, pushDeliveries, villageMembers, villages } from "~/lib/db/schema";
import { SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/jobs/mail-kinds";
import { SEND_PUSH_JOB } from "~/lib/push/enqueue.server";
import { registerPush } from "~/lib/push/subscriptions.server";
import { configurePush, identity, pushAuthorization, subscription } from "./push";

export async function enableNushiCallerDelivery(db: Db, callerId: string) {
  configurePush();
  await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, callerId));
  await registerPush(db, callerId, identity(), subscription(), "Firefox/1 Linux", await pushAuthorization(db, callerId));
}

export async function expectNushiDeliveryJobs(db: Db, citationId?: number) {
  const deliveryJobs = await db.select({ kind: jobs.kind, payload: jobs.payload }).from(jobs)
    .where(inArray(jobs.kind, [SEND_NOTIFICATION_EMAIL_JOB, SEND_PUSH_JOB]));
  expect(deliveryJobs).toEqual(citationId === undefined ? [] : [{ kind: SEND_NOTIFICATION_EMAIL_JOB, payload: { notificationId: citationId } }]);
  expect(await db.select().from(pushDeliveries)).toEqual([]);
}

export async function nushiFixture(options: Parameters<typeof createTestDb>[0] = {}) {
  vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRANSLATION_PRIMARY", "fake");
  const db = await createTestDb(options);
  await addMember(db, "nushi-owner", "znushi_owner");
  await addMember(db, "nushi-caller", "znushi_caller");
  await addMember(db, "nushi-follower", "znushi_follower");
  const [village] = await db.insert(villages).values({ kind: "open", slug: "nushi-test", name: "Nushi test" }).returning();
  for (const [id, role] of [["nushi-owner", "owner"], ["nushi-caller", "member"], ["nushi-follower", "member"]]) await db.insert(villageMembers).values({ villageId: village.id, userId: id, role });
  const source = await createTopic(db, "nushi-owner", { title: "Orchard evidence", body: "The orchard plan needs public review. Some growers disagree about timing.", lang: "en", village: village.slug });
  if (!source.ok) throw new Error(source.error);
  const topic = await createTopic(db, "nushi-caller", { body: "@nushi orchard", lang: "en", village: village.slug });
  if (!topic.ok) throw new Error(topic.error);
  const [request] = await db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id));
  if (!request) throw new Error("Missing Nushi request");
  return { db, village, source: source.id, topic: topic.id, request };
}
