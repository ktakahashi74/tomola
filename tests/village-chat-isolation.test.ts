import { consentChatMembers } from "./helpers/chat-consent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { entries, villageMembers, villages } from "~/lib/db/schema";
import { mutateChat } from "~/lib/village-chat.server";
import { buildChangesMarkdown } from "~/lib/md/changes.server";
import { searchEntries } from "~/lib/search.server";
import { exportSite } from "~/lib/site-export.server";
import { chatSourceHash, saveChatTranslation } from "~/lib/village-chat-translations.server";
import { exportOwnChat } from "~/lib/village-chat-own.server";
import { buildMemberExport, buildObservationExport } from "~/lib/exports.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => vi.unstubAllEnvs());
it("keeps chat text outside the public change feed, search and every site export artifact", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb(); await addMember(db, "isolation", "chat_isolation");
  const [village] = await db.insert(villages).values({ kind: "open", slug: "chat-isolation" }).returning();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "isolation" });
  await consentChatMembers(db);
  const marker = "confidential-chat-isolation-marker";
  const message = await mutateChat(db, "isolation", village.slug!, "send", { body: marker });
  const translatedMarker = "confidential-chat-translated-marker";
  await saveChatTranslation(db, { messageId: message.id, lang: "ja", sourceHash: chatSourceHash(marker) }, { state: "ready", text: translatedMarker });
  expect(JSON.stringify(await exportOwnChat(db, "isolation"))).not.toContain(translatedMarker);
  const [topic] = await db.insert(entries).values({ authorId: "isolation", kind: "topic", lang: "en", title: "Public title", body: "Public text", villageId: village.id, sourceHash: "a".repeat(64) }).returning({ id: entries.id });
  for (const content of [
    await buildThreadMarkdown(db, topic.id, { page: 1, lang: "all", sentences: true, k: null, readerId: "isolation" }),
    JSON.stringify(await buildObservationExport(db, { model: null })),
    JSON.stringify(await buildMemberExport(db, "isolation")),
  ]) expect(content).not.toContain(translatedMarker);
  expect(await buildChangesMarkdown(db, { since: new Date("2020-01-01"), k: null })).not.toContain(marker);
  expect(await buildChangesMarkdown(db, { since: new Date("2020-01-01"), k: null })).not.toContain(translatedMarker);
  expect(JSON.stringify(await searchEntries(db, marker, { readLangs: ["en"], displayLang: "en" }))).not.toContain(marker);
  expect(JSON.stringify(await searchEntries(db, translatedMarker, { readLangs: ["en"], displayLang: "en" }))).not.toContain(translatedMarker);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "village-chat-export-"));
  try {
    await exportSite(db, { outDir: path.join(directory, "export"), langs: ["en"] });
    async function check(dir: string): Promise<void> {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, item.name);
        if (item.isDirectory()) await check(target); else {
          const content = await fs.readFile(target);
          for (const text of [marker, translatedMarker]) expect(content.includes(Buffer.from(text)), item.name).toBe(false);
        }
      }
    }
    await check(directory);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
