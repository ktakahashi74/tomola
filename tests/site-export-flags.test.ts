import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { entries, translations } from "~/lib/db/schema";
import { exportSite } from "~/lib/site-export.server";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("~/lib/llm/flags", async importOriginal => ({ ...(await importOriginal<typeof import("~/lib/llm/flags")>()), FLAG_STRUCTURE_MISMATCH: "fixture_structure_flag" }));
it("exports the structure warning using the shared flag definition", async () => {
  const db = await createTestDb();
  await addMember(db, "author", "author");
  const [entry] = await db.insert(entries).values({ authorId: "author", kind: "topic", body: "原文", lang: "ja", sourceHash: "h" }).returning();
  await db.insert(translations).values({ entryId: entry.id, lang: "en", field: "body", kind: "primary", text: "Translated text", sourceHash: "h", flags: ["fixture_structure_flag"] });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tomola-export-flags-"));
  try {
    await exportSite(db, { outDir: path.join(dir, "out"), langs: ["en"] });
    const en = JSON.parse(await fs.readFile("messages/en.json", "utf8"));
    expect(await fs.readFile(path.join(dir, "out/en/t", `${entry.id}.md`), "utf8")).toContain(en.translation_structure_note);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
