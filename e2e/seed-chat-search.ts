import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { chatMessages, chatMessageTranslations, chatReads, chatSequences, profiles, villageMembers, villages } from "../app/lib/db/schema";
import { acceptChatConsent } from "../app/lib/village-chat.server";
import { chatSourceHash } from "../app/lib/village-chat-translations.server";
import { villageChatEnabled } from "../app/lib/village-chat-enabled.server";

export async function seedChatSearch(db: Db, dir: string) {
  if (!villageChatEnabled()) return;
  const fixture: Record<string, { first: string; deleted: string }> = {};
  for (const scenario of ["basic", "paging", "native", "gate"]) {
    const [village] = await db.insert(villages).values({ slug: `chat-search-${scenario}`, name: `Chat search ${scenario}`, kind: "open" }).returning();
    const ids: Record<string, string> = {};
    for (const role of scenario === "gate" ? ["author", "noagree"] : ["author", "reader"]) {
      const [profile] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, `cs_${scenario}_${role}`));
      ids[role] = profile.id;
      await db.insert(villageMembers).values({ villageId: village.id, userId: profile.id });
      if (role !== "noagree") await acceptChatConsent(db, profile.id, village.slug!);
    }
    const count = scenario === "basic" ? 80 : scenario === "paging" ? 45 : 1;
    const messages = await db.insert(chatMessages).values(Array.from({ length: count }, (_, i) => ({
      villageId: village.id, authorId: ids.author, lang: scenario === "basic" && i === 0 ? "ja" : "en",
      body: scenario === "basic" && i === 0 ? '昔の発言 %_\\ <script>alert("safe")</script>' : `${scenario}-search-phrase ${i + 1}`,
      createdSeq: i + 1, changedSeq: i + 1,
    }))).returning();
    await db.insert(chatSequences).values({ villageId: village.id, seq: count });
    if (ids.reader) await db.insert(chatReads).values({ villageId: village.id, userId: ids.reader, seq: count });
    if (scenario === "basic") await db.insert(chatMessageTranslations).values({ messageId: messages[0].id, lang: "en", sourceHash: chatSourceHash(messages[0].body), state: "ready", text: "translated-only-needle in an older message" });
    fixture[scenario] = { first: messages[0].id, deleted: messages[23]?.id ?? messages[0].id };
  }
  fs.writeFileSync(path.join(dir, "chat-search.json"), JSON.stringify(fixture));
}
