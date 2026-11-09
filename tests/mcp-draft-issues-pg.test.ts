import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drafts, profiles } from "~/lib/db/schema";
import * as markdownBudget from "~/lib/markdown-budget.server";
import { createClientDraft, updateClientDraft, type McpClientIdentity } from "~/lib/mcp/drafts.server";
import { changeVillageMembership, ensureLanguageVillages } from "~/lib/villages.server";
import { addMember } from "./helpers/db";
import { expectSettlesWithin } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("draft diagnostics after PostgreSQL commit", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterAll(async () => { await scratch?.drop(); }, 60_000);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("releases the draft and member locks and diagnoses the saved snapshot before a later edit", async () => {
    vi.stubEnv("VILLAGES", "1");
    const db = await scratch.open(), other = await scratch.open();
    await ensureLanguageVillages(db);
    await addMember(db, "draft-writer", "draft-writer");
    await changeVillageMembership(db, "draft-writer", "en", "join");
    const client: McpClientIdentity = { key: "oauth:diagnostics", id: "diagnostics", name: "Diagnostics", uri: null, tokenId: null };
    const initial = await createClientDraft(db, "draft-writer", client, { kind: "topic", lang: "en", body: "Initial draft", village: "en" });
    if (!initial.ok) throw new Error(initial.error);

    let announce!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const run = markdownBudget.markdownTask;
    vi.spyOn(markdownBudget, "markdownTask").mockImplementation(async <T>(operation: string, args: unknown[]): Promise<T> => {
      if (operation === "inspectDraftMarkdown") { announce(); await resume; }
      return run<T>(operation, args);
    });
    const updating = updateClientDraft(db, "draft-writer", client, initial.id, { body: "Saved edit @missing" });
    try {
      await expectSettlesWithin(entered, 5000, "draft diagnostics admission");
      await other.transaction(async tx => {
        await tx.select().from(profiles).where(eq(profiles.userId, "draft-writer")).for("update", { noWait: true });
        const [row] = await tx.select().from(drafts).where(eq(drafts.id, initial.id)).for("update", { noWait: true });
        expect(row).toMatchObject({ body: "Saved edit @missing", version: 2 });
        await tx.update(drafts).set({ body: "Later edit", version: sql`${drafts.version} + 1` }).where(eq(drafts.id, initial.id));
      });
    } finally { release(); await updating; }
    const saved = await updating;
    expect(saved).toMatchObject({ ok: true, draft: { body: "Saved edit @missing", version: 2 }, issues: [{ kind: "unknown_mention", excerpt: "@missing" }] });
    expect(await other.select().from(drafts).where(eq(drafts.id, initial.id))).toMatchObject([{ body: "Later edit", version: 3 }]);
  });
});
