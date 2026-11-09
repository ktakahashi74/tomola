import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { chatMessages, chatReads, chatSequences, profiles, villageMembers, villages } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { acceptChatConsent } from "../app/lib/village-chat.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedLeftNavigation(db: Db, dir: string) {
  if (!villagesEnabled()) return;
  const id = async (name: string) => (await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, `side_nav_${name}`)))[0].id;
  const author = await id("author");
  const fixture: Record<string, { slug: string; topic: number }> = {};
  for (const scenario of ["routes", "native", "read"]) {
    const reader = await id(scenario);
    const slug = `side-nav-${scenario}`;
    const [village] = await db.insert(villages).values({ slug, name: `Side navigation ${scenario}`, kind: "open" }).returning();
    await db.insert(villageMembers).values([reader, author].map(userId => ({ villageId: village.id, userId })));
    await acceptChatConsent(db, reader, slug);
    const count = scenario === "read" ? 32 : 3;
    await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({ villageId: village.id, authorId: author, lang: "en", body: `Side navigation ${scenario} message ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1 })));
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
    const topic = await createTopic(db, reader, { title: `Side navigation ${scenario} article`, body: "An independently owned navigation article.", lang: "en", village: slug }, { now: new Date("2015-01-01T00:00:00Z") });
    if (!topic.ok) throw new Error(topic.error);
    fixture[scenario] = { slug, topic: topic.id };
  }
  const reader = await id("live"), writer = await id("live_writer");
  for (const scenario of ["live", "other", "quiet", "no-consent"]) {
    const slug = `side-nav-${scenario}`;
    const [village] = await db.insert(villages).values({ slug, name: `Side navigation ${scenario}`, kind: "open" }).returning();
    await db.insert(villageMembers).values([reader, writer].map(userId => ({ villageId: village.id, userId })));
    if (scenario !== "no-consent") {
      for (const userId of [reader, writer]) await acceptChatConsent(db, userId, slug);
      await db.insert(chatMessages).values({ villageId: village.id, authorId: writer, body: "Already read navigation message", lang: "en", createdSeq: 1, changedSeq: 1 });
      await db.insert(chatSequences).values({ villageId: village.id, seq: 1 });
      await db.insert(chatReads).values({ villageId: village.id, userId: reader, seq: 1 });
    }
  }
  fs.writeFileSync(path.join(dir, "left-navigation.json"), JSON.stringify(fixture));
}
