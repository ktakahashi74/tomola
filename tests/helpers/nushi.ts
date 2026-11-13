import { vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./db";
import { createTopic } from "~/lib/entries.server";
import { nushiRequests, villageMembers, villages } from "~/lib/db/schema";

export async function nushiFixture() {
  vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRANSLATION_PRIMARY", "fake");
  const db = await createTestDb();
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
