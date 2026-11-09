import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { chatMessages, chatSequences, profiles, villageMembers, villages } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { acceptChatConsent } from "../app/lib/village-chat.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedNavigationShell(db: Db, dir: string) {
  if (!villagesEnabled()) return;
  const id = async (handle: string) => (await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, handle)))[0].id;
  const reader = await id("nav_shell_menu"), writer = await id("nav_shell_writer");
  for (const [slug, name, kind, count] of [
    ["nav-shell-open", "Navigation open village", "open", 2],
    ["nav-shell-invited", "Navigation invited village", "invite_public", 1],
  ] as const) {
    const [village] = await db.insert(villages).values({ slug, name, kind }).returning();
    await db.insert(villageMembers).values([reader, writer, await id("nav_shell_context")].map(userId => ({ villageId: village.id, userId })));
    await acceptChatConsent(db, reader, slug);
    await acceptChatConsent(db, await id("nav_shell_context"), slug);
    await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({ villageId: village.id, authorId: writer, lang: "en", body: `Navigation message ${i}`, createdSeq: i + 1, changedSeq: i + 1 })));
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
  }
  const [reading] = await db.insert(villages).values({ slug: "nav-shell-reading", name: "Navigation reading village", kind: "open" }).returning();
  const author = await id("nav_shell_articles");
  await db.insert(villageMembers).values({ villageId: reading.id, userId: author });
  const fixture: Record<string, number[]> = {};
  for (const village of [reading.slug!, "en"]) {
    fixture[village] = [];
    for (let i = 0; i < 4; i++) {
      const topic = await createTopic(db, author, { title: `Navigation ${village} article ${i}`, body: "An independently owned public reading route.", lang: "en", village }, { now: new Date(`2017-01-0${i + 1}T00:00:00Z`) });
      if (!topic.ok) throw new Error(topic.error);
      fixture[village].push(topic.id);
    }
  }
  for (const scenario of ["settings", "native"]) {
    const topic = await createTopic(db, await id(`nav_shell_${scenario}`), { title: `Navigation settings ${scenario}`, body: "Return to this owned page.", lang: "en", village: "en" }, { now: new Date("2017-01-01T00:00:00Z") });
    if (!topic.ok) throw new Error(topic.error);
    fixture[scenario] = [topic.id];
  }
  fs.writeFileSync(path.join(dir, "navigation-shell.json"), JSON.stringify(fixture));
}
