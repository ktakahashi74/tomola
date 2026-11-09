import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { PG_MODE } from "./helpers/pg-test";
import { createTestDb, addMember } from "./helpers/db";
import { entries, profiles, villages, villageMembers, roles } from "~/lib/db/schema";
import { createTopic, createReply, getThread, listTopics } from "~/lib/entries.server";
import { setIntroduction } from "~/lib/member-pages.server";
import { getViewer } from "~/lib/roles.server";
import { changeHomeArea } from "~/lib/profiles.server";
import { personalVillage } from "~/lib/personal-villages.server";
import { setDefaultVillage, assertVillagesReady, changeVillageMembership, ensureLanguageVillages, languageVillage, listVillages, topicVillage } from "~/lib/villages.server";
import { prepareVillages, runPrepareVillages } from "~/lib/villages-prepare.server";
import { parseVillages, villagesEnabled } from "~/lib/villages-enabled.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { buildListMarkdown } from "~/lib/md/lists.server";

const input = { title: "A topic", body: "A body.", lang: "en" };
const env = { ENABLED_LANGS: "ja,en", VILLAGES: "" };
afterEach(() => vi.unstubAllEnvs());
async function setup(languageDefault = true) {
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "alice", "alice", { homeArea: "ja" });
  if (languageDefault) await setDefaultVillage(db, "alice", "ja");
  return db;
}
async function defaultOf(db: Awaited<ReturnType<typeof createTestDb>>, userId = "alice") {
  return (await db.select({ id: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, userId)))[0].id;
}

describe("village foundations", () => {
  it("accepts only empty or 1 settings", () => {
    expect(villagesEnabled({})).toBe(false);
    expect(villagesEnabled({ VILLAGES: " 1 " })).toBe(true);
    for (const value of ["0", "true", "false", "yes", "2"]) expect(parseVillages(value).ok).toBe(false);
  });
  it("creates random IDs and language villages idempotently, including lowercase Chinese slugs", async () => {
    const db = await createTestDb();
    await ensureLanguageVillages(db, { ENABLED_LANGS: "ja,en,zh-Hans" });
    const before = await db.select().from(villages);
    await ensureLanguageVillages(db, { ENABLED_LANGS: "ja,en,zh-Hans" });
    expect(await db.select().from(villages)).toEqual(before);
    expect(before).toHaveLength(3);
    for (const row of before) expect(row.id).toMatch(/^[a-f0-9]{32}$/);
    expect(before.find(v => v.language === "zh-Hans")?.slug).toBe("zh-hans");
    await expect(db.update(villages).set({ endedAt: new Date() }).where(eq(villages.language, "ja"))).rejects.toThrow();
  });
  it("enrolls new members in their language while preserving their personal default across main-language changes", async () => {
    const db = await setup(false);
    const ja = (await languageVillage(db, "ja"))!;
    const personalId = (await personalVillage(db, "alice"))!.id;
    expect(await defaultOf(db)).toBe(personalId);
    expect(await db.select().from(villageMembers)).toMatchObject([{ villageId: ja.id, userId: "alice", role: "member" }]);
    await addMember(db, "other", "other_member", { homeArea: "other" });
    expect(await defaultOf(db, "other")).toBe((await personalVillage(db, "other"))!.id);
    await db.delete(villages).where(eq(villages.language, "en"));
    await addMember(db, "missing", "missing", { homeArea: "en" });
    expect(await defaultOf(db, "missing")).toBe((await personalVillage(db, "missing"))!.id);
    expect((await changeHomeArea(db, "alice", "en")).ok).toBe(true);
    expect(await defaultOf(db)).toBe(personalId);
  });
  it("assigns the default village independently of original language; replies by nonmembers remain unplaced", async () => {
    const db = await setup();
    const topic = await createTopic(db, "alice", input);
    expect(topic.ok).toBe(true);
    if (!topic.ok) return;
    expect((await topicVillage(db, topic.id))?.slug).toBe("ja");
    await addMember(db, "other", "other_member", { homeArea: "other" });
    const reply = await createReply(db, "other", topic.id, { lang: "en", body: "A reply from outside the village." });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect((await db.select().from(entries).where(eq(entries.id, reply.id)))[0].villageId).toBeNull();
  });
  it("resolves unset or unavailable defaults to the personal village but rejects an explicit unjoined target", async () => {
    const db = await setup();
    await addMember(db, "other", "other_member", { homeArea: "other" });
    await db.update(profiles).set({ defaultVillageId: null }).where(eq(profiles.userId, "other"));
    expect(await createTopic(db, "other", input)).toMatchObject({ ok: true });
    const en = (await languageVillage(db, "en"))!;
    await db.update(profiles).set({ defaultVillageId: en.id }).where(eq(profiles.userId, "alice"));
    expect(await createTopic(db, "alice", input)).toMatchObject({ ok: true });
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    expect(await createTopic(db, "alice", { ...input, village: "en" })).toEqual({ ok: false, error: "village_required" });
    expect(await db.select().from(entries)).toHaveLength(2);
  });
  it("joins idempotently and restores the personal village on leave", async () => {
    const db = await setup();
    const en = (await languageVillage(db, "en"))!;
    const ja = (await languageVillage(db, "ja"))!;
    await changeVillageMembership(db, "alice", "EN", "join");
    await changeVillageMembership(db, "alice", "en", "join");
    expect(await defaultOf(db)).toBe(ja.id);
    expect(await db.select().from(villageMembers)).toHaveLength(2);
    await changeVillageMembership(db, "alice", "ja", "leave");
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    await changeVillageMembership(db, "alice", "en", "leave");
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    await changeVillageMembership(db, "alice", "ja", "join");
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    expect(await changeVillageMembership(db, "alice", "absent", "join")).toBe(false);
  });
  it("restores the personal default regardless of remaining membership age", async () => {
    const db = await setup();
    await ensureLanguageVillages(db, { ENABLED_LANGS: "ja,en,fr" });
    await changeVillageMembership(db, "alice", "fr", "join");
    await changeVillageMembership(db, "alice", "en", "join");
    const fr = (await languageVillage(db, "fr"))!;
    await db.update(villageMembers).set({ joinedAt: new Date("2020-01-01") }).where(and(eq(villageMembers.userId, "alice"), eq(villageMembers.villageId, fr.id)));
    await changeVillageMembership(db, "alice", "ja", "leave");
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
  });
  it.runIf(PG_MODE)("serializes an in-flight topic with leaving its default village", { tags: ["postgres"] }, async () => {
    const db = await setup();
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const leaving = db.transaction(async tx => {
      await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, "alice")).for("update");
      ready();
      await gate;
      return changeVillageMembership(tx, "alice", "ja", "leave");
    });
    await locked;
    const posting = createTopic(db, "alice", { ...input, village: "ja" });
    try {
      await vi.waitFor(async () => {
        const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%default_village_id%'`);
        expect((result as { rows: { n: number }[] }).rows[0].n).toBeGreaterThan(0);
      }, { timeout: 5000, interval: 25 });
    } finally {
      release();
      await leaving;
    }
    expect(await posting).toEqual({ ok: false, error: "village_required" });
    expect(await db.select().from(entries)).toEqual([]);
  });
  it("paginates village topics with the same boundaries in HTML data and Markdown", async () => {
    const db = await setup();
    const ja = (await languageVillage(db, "ja"))!;
    await db.insert(entries).values(Array.from({ length: 31 }, (_, index) => ({ kind: "topic", authorId: "alice", lang: "ja", title: `Village page ${index}`, body: "A body.", villageId: ja.id, createdAt: new Date(Date.UTC(2025, 0, 1, 0, index)) })));
    const first = await listTopics(db, { kind: "village", villageId: ja.id }, { order: "created" });
    const second = await listTopics(db, { kind: "village", villageId: ja.id }, { order: "created", page: 2 });
    expect(first.topics).toHaveLength(30);
    expect(first.hasNext).toBe(true);
    expect(second.topics).toHaveLength(1);
    expect(second.hasNext).toBe(false);
    const markdown = await buildListMarkdown(db, null, { kind: "village", slug: "ja", villageId: ja.id }, { page: 1, lang: null, k: null });
    expect(markdown).toContain("/v/ja.md?page=2");
    expect(markdown).not.toMatch(new RegExp(String.raw`id: ["']?p-${second.topics[0].id}(?:["']|\s|$)`));
  });
  it("limits topic listings and Markdown to the chosen village, using slugs in thread frontmatter", async () => {
    const db = await setup();
    await addMember(db, "bob", "bob", { homeArea: "en" });
    const jaTopic = await createTopic(db, "alice", input);
    const enTopic = await createTopic(db, "bob", { ...input, title: "Other village", village: "en" });
    if (!jaTopic.ok || !enTopic.ok) throw new Error("topic failed");
    const ja = (await languageVillage(db, "ja"))!;
    expect((await listTopics(db, { kind: "village", villageId: ja.id }, { order: "created" })).topics.map(t => t.id)).toEqual([jaTopic.id]);
    const markdown = await buildListMarkdown(db, null, { kind: "village", slug: "ja", villageId: ja.id }, { page: 1, lang: null, k: null });
    expect(markdown).toContain(`p-${jaTopic.id}`);
    expect(markdown).not.toContain(`p-${enTopic.id}`);
    expect(markdown).not.toContain(ja.id);
    const thread = await buildThreadMarkdown(db, jaTopic.id, { page: 1, lang: null, sentences: false, k: null });
    expect(thread).toMatch(/village: ["']?ja/);
    expect(thread).not.toContain(ja.id);
    const directory = await buildListMarkdown(db, null, { kind: "villages" }, { page: 1, lang: null, k: null });
    expect(directory).not.toContain("members:");
  });
  it("keeps registration, topic placement and Markdown unchanged when disabled, without village-table queries", async () => {
    const db = await createTestDb();
    const from = vi.fn();
    function watch(handle: typeof db, inTransaction = false) {
      const select = handle.select.bind(handle);
      vi.spyOn(handle, "select").mockImplementation(((...args: Parameters<typeof select>) => {
        const builder = select(...args);
        const original = builder.from.bind(builder);
        builder.from = ((table: Parameters<typeof original>[0]) => { from(table, inTransaction); return original(table); }) as typeof builder.from;
        return builder;
      }) as typeof handle.select);
      const transaction = handle.transaction.bind(handle);
      vi.spyOn(handle, "transaction").mockImplementation(((callback: Parameters<typeof transaction>[0], config: Parameters<typeof transaction>[1]) => transaction(tx => {
        watch(tx, true);
        return callback(tx);
      }, config)) as typeof handle.transaction);
    }
    watch(db);
    await addMember(db, "alice", "alice");
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    from.mockClear();
    const topic = await createTopic(db, "alice", input);
    if (!topic.ok) throw new Error(topic.error);
    expect((await db.select().from(entries).where(eq(entries.id, topic.id)))[0].villageId).toBeNull();
    expect(await buildThreadMarkdown(db, topic.id, { page: 1, lang: null, sentences: false, k: null })).not.toContain("village:");
    expect(from.mock.calls.some(([table]) => table === villages || table === villageMembers)).toBe(false);
    expect(from.mock.calls.some(([table, inTransaction]) => table === profiles && inTransaction)).toBe(true);
    await expect(assertVillagesReady(db, env)).resolves.toBeUndefined();
  });
});

describe("operator preparation and startup readiness", () => {
  it("never reenrolls a member who left, and prepares new members registered while closed", async () => {
    const db = await setup();
    const originalStamp = (await db.select().from(profiles).where(eq(profiles.userId, "alice")))[0].villagePreparedAt;
    expect(originalStamp).toBeInstanceOf(Date);
    await changeVillageMembership(db, "alice", "ja", "leave");
    vi.stubEnv("VILLAGES", "");
    await addMember(db, "later", "later_member", { homeArea: "en" });
    expect((await db.select().from(profiles).where(eq(profiles.userId, "later")))[0].villagePreparedAt).toBeNull();
    for (let pass = 0; pass < 2; pass++) {
      await prepareVillages(db, { env, write: true });
      expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
      expect(await db.select().from(villageMembers).where(eq(villageMembers.userId, "alice"))).toEqual([]);
      expect((await db.select().from(profiles).where(eq(profiles.userId, "alice")))[0].villagePreparedAt).toEqual(originalStamp);
      expect(await defaultOf(db, "later")).toBe((await personalVillage(db, "later"))!.id);
    }
    await changeVillageMembership(db, "later", "en", "leave");
    await prepareVillages(db, { env, write: true });
    expect(await defaultOf(db, "later")).toBe((await personalVillage(db, "later"))!.id);
    expect(await db.select().from(villageMembers)).toEqual([]);
  });
  it("keeps a manual join and subsequent departure out of initial preparation", async () => {
    const db = await setup();
    await addMember(db, "other", "other_member", { homeArea: "other" });
    await changeVillageMembership(db, "other", "en", "join");
    await changeVillageMembership(db, "other", "en", "leave");
    await changeHomeArea(db, "other", "en");
    await prepareVillages(db, { env, write: true });
    expect(await defaultOf(db, "other")).toBe((await personalVillage(db, "other"))!.id);
  });
  it.runIf(PG_MODE)("allows simultaneous insertion of the same language villages", { tags: ["postgres"] }, async () => {
    const db = await createTestDb();
    await Promise.all([ensureLanguageVillages(db, env), ensureLanguageVillages(db, env)]);
    expect((await db.select().from(villages)).map(row => row.language).sort()).toEqual(["en", "ja"]);
  });
  it("adds hidden-topic village metadata only for readers allowed to see it on screen", async () => {
    const db = await setup();
    const topic = await createTopic(db, "alice", input);
    if (!topic.ok) throw new Error(topic.error);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
    await addMember(db, "mod", "village_moderator");
    await addMember(db, "wrongmod", "wrong_moderator");
    await addMember(db, "operator", "village_operator");
    await addMember(db, "outsider", "outsider");
    await db.insert(roles).values([{ userId: "mod", role: "moderator", lang: "en" }, { userId: "wrongmod", role: "moderator", lang: "ja" }]);
    vi.stubEnv("OPERATOR_EMAILS", "operator@example.com");
    for (const readerId of [undefined, "alice", "mod", "wrongmod", "operator", "outsider"]) {
      const viewer = readerId ? await getViewer(db, { id: readerId, email: `${readerId}@example.com` }) : undefined;
      const screen = await getThread(db, topic.id, { viewer });
      const authorized = screen!.topic.visibility !== "hidden-redacted";
      const markdown = await buildThreadMarkdown(db, topic.id, { page: 1, lang: null, sentences: false, k: null, readerId });
      expect(markdown?.includes("village:")).toBe(authorized);
      expect(markdown).not.toContain(input.body);
      expect(markdown).not.toContain(input.title);
    }
    vi.stubEnv("VILLAGES", "");
    expect(await buildThreadMarkdown(db, topic.id, { page: 1, lang: null, sentences: false, k: null, readerId: "alice" })).not.toContain("village:");
  });
  it.runIf(PG_MODE)("takes the author profile lock before the introduction topic lock", { tags: ["postgres"] }, async () => {
    const db = await setup();
    const topic = await createTopic(db, "alice", input);
    if (!topic.ok) throw new Error(topic.error);
    let started!: () => void;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    const designation = db.transaction(async tx => {
      await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, "alice")).for("update");
      const pending = setIntroduction(db, "alice", topic.id);
      // Keep rejection handled while the transaction holding the lock finishes.
      void pending.catch(() => {});
      started();
      // If designation locked the topic while waiting on this profile, this times out.
      await tx.execute(sql`set local lock_timeout = '1s'`);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        // Poll from a separate connection; transaction-local statistics can retain the first snapshot.
        const result = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%profiles%'`) as { rows: { pid: number }[] };
        waiting = result.rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, topic.id)).for("no key update");
      return { pending };
    });
    await beginning;
    const { pending } = await designation;
    expect(await pending).toEqual({ ok: true });
  });
  it("plans without writes while disabled, backfills by posting area or original language, then becomes idempotent", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await addMember(db, "alice", "alice", { homeArea: "ja" });
    await addMember(db, "other", "other_member", { homeArea: "other" });
    const first = await createTopic(db, "alice", input);
    const fallback = await createTopic(db, "other", input);
    if (!first.ok || !fallback.ok) throw new Error("topic failed");
    await changeHomeArea(db, "alice", "en");
    const plan = await prepareVillages(db, { env });
    expect(plan).toMatchObject({ written: false, memberships: 1, defaults: 0, topics: 2, unresolved: [] });
    expect((await db.select().from(villages)).every(row => row.kind === "personal")).toBe(true);
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    await prepareVillages(db, { env, write: true });
    expect((await topicVillage(db, first.id))?.slug).toBe("ja");
    expect((await topicVillage(db, fallback.id))?.slug).toBe("en");
    expect(await defaultOf(db)).toBe((await personalVillage(db, "alice"))!.id);
    expect(await defaultOf(db, "other")).toBe((await personalVillage(db, "other"))!.id);
    const before = await db.select().from(villageMembers);
    expect(await prepareVillages(db, { env, write: true })).toMatchObject({ missingLanguages: [], memberships: 0, defaults: 0, topics: 0 });
    expect(await db.select().from(villageMembers)).toEqual(before);
    await expect(assertVillagesReady(db, { ...env, VILLAGES: "1" })).resolves.toBeUndefined();
  });
  it("stops all writes for an unmatched posting area rather than substituting a different language", async () => {
    const db = await createTestDb();
    await addMember(db, "alice", "alice", { homeArea: "fr" });
    await changeVillageMembership(db, "alice", "fr", "join");
    await setDefaultVillage(db, "alice", "fr");
    const topic = await createTopic(db, "alice", input);
    if (!topic.ok) throw new Error(topic.error);
    const errors: string[] = [];
    expect(await runPrepareVillages(["--write"], { getDb: async () => db, env, log: () => {}, error: line => errors.push(line) })).toBe(1);
    expect(errors.join("\n")).toContain(`topic ${topic.id}`);
    expect((await db.select().from(villages)).every(row => row.kind === "personal")).toBe(true);
    expect((await db.select().from(entries))[0].villageId).toBeNull();
  });
  it("preserves an existing default and placement, and rejects conflicting language slugs without writes", async () => {
    const db = await setup();
    const topic = await createTopic(db, "alice", input);
    if (!topic.ok) throw new Error(topic.error);
    const jaId = await defaultOf(db);
    await changeHomeArea(db, "alice", "en");
    await prepareVillages(db, { env, write: true });
    expect(await defaultOf(db)).toBe(jaId);
    expect((await topicVillage(db, topic.id))?.slug).toBe("ja");
    await db.insert(villages).values({ slug: "fr", kind: "open", name: "A different village" });
    const plan = await prepareVillages(db, { env: { ENABLED_LANGS: "ja,en,fr" }, write: true });
    expect(plan).toMatchObject({ written: false, collisions: ["fr"] });
    expect(await languageVillage(db, "fr")).toBeNull();
  });
  it("refuses enabling without complete language villages and placements; a closed check does no reads", async () => {
    const db = await createTestDb();
    await expect(assertVillagesReady(db, { ...env, VILLAGES: "1" })).rejects.toThrow("villages:prepare");
    await ensureLanguageVillages(db, env);
    await addMember(db, "alice", "alice");
    await createTopic(db, "alice", input);
    await expect(assertVillagesReady(db, { ...env, VILLAGES: "1" })).rejects.toThrow("1 topics");
    const spy = vi.spyOn(db, "select");
    await assertVillagesReady(db, env);
    expect(spy).not.toHaveBeenCalled();
  });
  it("uses an existing language village even when its language is no longer enabled", async () => {
    const db = await createTestDb();
    await ensureLanguageVillages(db, { ENABLED_LANGS: "ja,en,fr" });
    await addMember(db, "alice", "alice", { homeArea: "fr" });
    await changeVillageMembership(db, "alice", "fr", "join");
    await setDefaultVillage(db, "alice", "fr");
    const topic = await createTopic(db, "alice", input);
    if (!topic.ok) throw new Error(topic.error);
    const result = await prepareVillages(db, { env, write: true });
    expect(result.unresolved).toEqual([]);
    expect((await topicVillage(db, topic.id))?.slug).toBe("fr");
    expect(await defaultOf(db)).toBe((await languageVillage(db, "fr"))!.id);
  });
  it("validates command arguments before opening the database", async () => {
    const getDb = vi.fn();
    expect(await runPrepareVillages(["--unknown"], { getDb, error: () => {} })).toBe(1);
    expect(await runPrepareVillages(["--write", "--dry-run"], { getDb, error: () => {} })).toBe(1);
    expect(getDb).not.toHaveBeenCalled();
  });
});
