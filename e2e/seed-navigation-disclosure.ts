import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles, villageMembers, villages } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedNavigationDisclosure(db: Db, dir: string) {
  if (!villagesEnabled()) return;
  const [author] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "nav_single_author"));
  const [village] = await db.insert(villages).values({ slug: "nav-single-article", name: "Single article village", kind: "open" }).returning();
  await db.insert(villageMembers).values({ villageId: village.id, userId: author.id });
  const topic = await createTopic(db, author.id, { title: "An article with no village peers", body: "An independently owned navigation scenario.", lang: "en", village: village.slug }, { now: new Date("2016-01-01T00:00:00Z") });
  if (!topic.ok) throw new Error(topic.error);
  const [touchAuthor] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, "nav_touch_menu"));
  const touch = await createTopic(db, touchAuthor.id, { title: "A touch navigation article", body: "Text outside village navigation.", lang: "en", village: "en" }, { now: new Date("2016-01-01T00:00:00Z") });
  if (!touch.ok) throw new Error(touch.error);
  fs.writeFileSync(path.join(dir, "navigation-disclosure.json"), JSON.stringify({ id: topic.id, touchId: touch.id }));
}
