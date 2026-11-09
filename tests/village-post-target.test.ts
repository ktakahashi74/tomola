import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { PG_MODE } from "./helpers/pg-test";
import { addMember, createTestDb } from "./helpers/db";
import { drafts, entries, profiles, villageMembers, villages } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { createDraft, getDraft, publishDraft, updateDraft } from "~/lib/drafts.server";
import { personalVillage } from "~/lib/personal-villages.server";
import { changeVillageMembership, ensureLanguageVillages, languageVillage, listVillages, postingVillages, restoreEndedDefaultVillage, setDefaultVillage, topicVillage } from "~/lib/villages.server";
import { applyPastedFrontmatter } from "~/lib/entry-form.server";
import { interpretFrontmatter } from "~/lib/entry-frontmatter.server";
import { buildDraftMarkdown } from "~/lib/md/draft.server";
import { createClientDraft, updateClientDraft, type McpClientIdentity } from "~/lib/mcp/drafts.server";

const input = { title: "Destination fixture", body: "An owned destination fixture.", lang: "en" };
const client: McpClientIdentity = { key: "oauth:destination", id: "destination", name: "Destination fixture", uri: null, tokenId: null };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "actor", "vt_actor", { homeArea: "ja" });
  return db;
}
async function defaultId(db: Awaited<ReturnType<typeof setup>>) {
  return (await db.select({ id: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, "actor")))[0].id;
}

describe("village destinations", () => {
  it("switches a topic destination without changing its language, posting area or default", async () => {
    const db = await setup();
    await changeVillageMembership(db, "actor", "en", "join");
    const before = await defaultId(db);
    const topic = await createTopic(db, "actor", { ...input, village: "EN" });
    if (!topic.ok) throw new Error(topic.error);
    expect((await topicVillage(db, topic.id))?.slug).toBe("en");
    expect((await db.select().from(entries))[0]).toMatchObject({ lang: "en", authorArea: "ja" });
    expect(await defaultId(db)).toBe(before);
    expect(await setDefaultVillage(db, "actor", "en")).toBe(true);
    const implicit = await createTopic(db, "actor", input);
    if (!implicit.ok) throw new Error(implicit.error);
    expect((await topicVillage(db, implicit.id))?.slug).toBe("en");
    expect(await setDefaultVillage(db, "actor", "absent")).toBe(false);
    expect(await defaultId(db)).toBe((await languageVillage(db, "en"))!.id);
  });

  it("refuses all five unavailable targets with the same error and no silent substitution", async () => {
    const db = await setup();
    const rows = await db.insert(villages).values([
      { slug: "unjoined", name: "Unjoined", kind: "open" },
      { slug: "retired", name: "Retired", kind: "open", endedAt: new Date() },
      { slug: "private", name: "Private", kind: "closed" },
    ]).returning();
    await db.insert(villageMembers).values(rows.filter(row => row.slug !== "unjoined").map(row => ({ villageId: row.id, userId: "actor" })));
    for (const village of ["unjoined", "retired", "absent", "private", "@someone_else"]) {
      expect(await createTopic(db, "actor", { ...input, village })).toEqual({ ok: false, error: "village_required" });
      expect(await createDraft(db, "actor", { kind: "topic", ...input, village }, { via: "api" })).toEqual({ ok: false, error: "village_required" });
      expect(await createClientDraft(db, "actor", client, { kind: "topic", ...input, village })).toEqual({ ok: false, error: "village_required" });
    }
    expect(await db.select().from(entries)).toEqual([]);
    expect(await db.select().from(drafts)).toEqual([]);
  });

  it("keeps a draft's chosen destination after default changes and refuses publication after leaving it", async () => {
    const db = await setup();
    await changeVillageMembership(db, "actor", "en", "join");
    const saved = await createDraft(db, "actor", { kind: "topic", ...input, village: "en" });
    if (!saved.ok) throw new Error(saved.error);
    expect((await getDraft(db, "actor", saved.id))?.village).toBe("en");
    expect(buildDraftMarkdown((await getDraft(db, "actor", saved.id))!)).toMatch(/village: ["']?en/);
    await changeVillageMembership(db, "actor", "en", "leave");
    expect(await publishDraft(db, "actor", saved.id)).toEqual({ ok: false, error: "village_required" });
    expect(await getDraft(db, "actor", saved.id)).not.toBeNull();
    await changeVillageMembership(db, "actor", "en", "join");
    expect(await updateDraft(db, "actor", saved.id, { ...input, village: "ja" })).toMatchObject({ ok: true });
    const published = await publishDraft(db, "actor", saved.id);
    if (!published.ok) throw new Error(published.error);
    expect((await topicVillage(db, published.id))?.slug).toBe("ja");
  });

  it("publishes an old NULL destination through the current default and leaves incomplete browser drafts saveable", async () => {
    const db = await setup();
    vi.stubEnv("VILLAGES", "");
    const old = await createDraft(db, "actor", { kind: "topic", ...input, village: "unknown" });
    if (!old.ok) throw new Error(old.error);
    vi.stubEnv("VILLAGES", "1");
    await changeVillageMembership(db, "actor", "en", "join");
    await setDefaultVillage(db, "actor", "en");
    const published = await publishDraft(db, "actor", old.id);
    if (!published.ok) throw new Error(published.error);
    expect((await topicVillage(db, published.id))?.slug).toBe("en");
    await db.update(profiles).set({ defaultVillageId: null }).where(eq(profiles.userId, "actor"));
    const incomplete = await createDraft(db, "actor", { kind: "topic", ...input });
    if (!incomplete.ok) throw new Error(incomplete.error);
    expect(await publishDraft(db, "actor", incomplete.id)).toMatchObject({ ok: true });
  });

  it("groups memberships and counts in one query and excludes unavailable destinations", async () => {
    const db = await setup();
    await addMember(db, "reader", "vt_reader", { homeArea: "ja" });
    const spy = vi.spyOn(db, "select");
    const rows = await listVillages(db, "actor");
    expect(spy).toHaveBeenCalledOnce();
    expect(rows.find(row => row.slug === "ja")).toMatchObject({ joined: true, members: 2 });
    expect(rows.find(row => row.slug === "en")).toMatchObject({ joined: false, members: 0 });
    spy.mockRestore();
  });

  it("repairs ended defaults to the personal village once", async () => {
    const db = await setup();
    const transaction = vi.spyOn(db, "transaction");
    expect(await postingVillages(db, "actor")).toMatchObject({ selected: "@vt_actor", changed: false });
    await db.update(profiles).set({ defaultVillageId: null }).where(eq(profiles.userId, "actor"));
    expect(await restoreEndedDefaultVillage(db, "actor")).toEqual({ changed: false, defaultVillageId: null });
    expect(transaction).not.toHaveBeenCalled();
    const [ended] = await db.insert(villages).values({ slug: "ended-choice", name: "Ended", kind: "open", endedAt: new Date() }).returning();
    await db.update(profiles).set({ defaultVillageId: ended.id }).where(eq(profiles.userId, "actor"));
    expect((await postingVillages(db, "actor", undefined, { repair: false })).changed).toBe(false);
    expect(await defaultId(db)).toBe(ended.id);
    expect(await restoreEndedDefaultVillage(db, "actor")).toMatchObject({ changed: true, defaultVillageId: (await personalVillage(db, "actor"))!.id });
    expect(transaction).toHaveBeenCalledOnce();
    expect((await restoreEndedDefaultVillage(db, "actor")).changed).toBe(false);
    await changeVillageMembership(db, "actor", "ja", "leave");
    await db.update(profiles).set({ defaultVillageId: ended.id }).where(eq(profiles.userId, "actor"));
    const screen = await postingVillages(db, "actor");
    expect(screen).toMatchObject({ selected: "@vt_actor", changed: true });
    expect(await defaultId(db)).toBe((await personalVillage(db, "actor"))!.id);
  });

  it("uses pasted village declarations until the member makes an explicit selection", async () => {
    await setup();
    const body = "---\nvillage: en\n---\nAn owned body.";
    const raw = { title: "", body, lang: "en", asksStance: false, altOf: null, stanceTag: null, village: "ja", villageExplicit: false };
    const pasted = await applyPastedFrontmatter(raw, "topic", { defaultLang: "en" });
    expect(pasted).toMatchObject({ ok: true, input: { village: "en" } });
    expect(await applyPastedFrontmatter({ ...raw, villageExplicit: true }, "topic", { defaultLang: "en" })).toMatchObject({ ok: true, input: { village: "ja" } });
    expect(interpretFrontmatter({ village: 123 })).toEqual({ ok: false, error: "village_required" });
  });

  it("adds no village target to replies and accepts replies from outside the village", async () => {
    const db = await setup();
    const topic = await createTopic(db, "actor", input);
    if (!topic.ok) throw new Error(topic.error);
    await addMember(db, "outside", "vt_outside", { homeArea: "other" });
    const reply = await createDraft(db, "outside", { kind: "reply", threadId: topic.id, ...input }, { via: "api" });
    if (!reply.ok) throw new Error(reply.error);
    expect((await db.select().from(drafts).where(eq(drafts.id, reply.id)))[0].villageId).toBeNull();
    expect(await getDraft(db, "outside", reply.id)).not.toHaveProperty("village");
    expect(await publishDraft(db, "outside", reply.id)).toMatchObject({ ok: true, kind: "reply" });
    await expect(db.insert(drafts).values({ authorId: "outside", kind: "reply", threadId: topic.id, body: "Invalid stored reply.", lang: "en", villageId: (await languageVillage(db, "ja"))!.id })).rejects.toThrow();
  });

  it("makes no village reads even inside draft and posting transactions when disabled", async () => {
    vi.stubEnv("VILLAGES", "");
    const db = await createTestDb();
    const reads: unknown[] = [];
    function watch(handle: typeof db) {
      const select = handle.select.bind(handle);
      vi.spyOn(handle, "select").mockImplementation(((...args: Parameters<typeof select>) => {
        const builder = select(...args); const from = builder.from.bind(builder);
        builder.from = ((table: Parameters<typeof from>[0]) => { reads.push(table); return from(table); }) as typeof builder.from;
        return builder;
      }) as typeof handle.select);
      const transaction = handle.transaction.bind(handle);
      vi.spyOn(handle, "transaction").mockImplementation(((callback: Parameters<typeof transaction>[0], config: Parameters<typeof transaction>[1]) => transaction(tx => { watch(tx); return callback(tx); }, config)) as typeof handle.transaction);
    }
    watch(db);
    await addMember(db, "actor", "vt_disabled");
    reads.length = 0;
    const created = await createClientDraft(db, "actor", client, { kind: "topic", ...input, village: "ignored" });
    if (!created.ok) throw new Error(created.error);
    expect(created).not.toHaveProperty("village");
    expect(await updateClientDraft(db, "actor", client, created.id, { village: "ignored-again", body: "Updated off body." })).toMatchObject({ ok: true });
    const draft = (await getDraft(db, "actor", created.id))!;
    expect(draft).not.toHaveProperty("village");
    expect(buildDraftMarkdown(draft)).not.toContain("village:");
    expect(await publishDraft(db, "actor", created.id)).toMatchObject({ ok: true });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.includes(villages) || reads.includes(villageMembers)).toBe(false);
  });

  it.runIf(PG_MODE)("takes the profile lock before the draft lock in both update and publication", { tags: ["postgres"] }, async () => {
    const db = await setup();
    const saved = await createClientDraft(db, "actor", client, { kind: "topic", ...input });
    if (!saved.ok) throw new Error(saved.error);
    for (const operation of [() => updateClientDraft(db, "actor", client, saved.id, { village: "ja" }), () => publishDraft(db, "actor", saved.id)]) {
      const { pending } = await db.transaction(async tx => {
        await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, "actor")).for("update");
        const pending = operation(); void pending.catch(() => {});
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await vi.waitFor(async () => {
          const result = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%profiles%'`) as { rows: { pid: number }[] };
          expect(result.rows.length).toBeGreaterThan(0);
        }, { timeout: 5000, interval: 25 });
        await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, saved.id)).for("update");
        return { pending };
      });
      expect(await pending).toMatchObject({ ok: true });
    }
  });

  it.runIf(PG_MODE)("serializes an explicit destination with leaving that village", { tags: ["postgres"] }, async () => {
    const db = await setup(); await changeVillageMembership(db, "actor", "en", "join");
    const { pending } = await db.transaction(async tx => {
      await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, "actor")).for("update");
      const pending = createTopic(db, "actor", { ...input, village: "en" }); void pending.catch(() => {});
      await vi.waitFor(async () => {
        const result = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%profiles%'`) as { rows: { pid: number }[] };
        expect(result.rows.length).toBeGreaterThan(0);
      }, { timeout: 5000, interval: 25 });
      await changeVillageMembership(tx, "actor", "en", "leave");
      return { pending };
    });
    expect(await pending).toEqual({ ok: false, error: "village_required" });
    expect(await db.select().from(entries)).toEqual([]);
  });
});
