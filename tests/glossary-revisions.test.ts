import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type Db } from "~/lib/db/client.server";
import { entries, glossaryEntries, glossaryRevisions } from "~/lib/db/schema";
import { createTopic, createReply } from "~/lib/entries.server";
import { glossaryChangeKind } from "~/lib/glossary";
import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  listGlossary,
  listGlossaryRevisions,
  resolveProposal,
  updateGlossaryEntry,
  type GlossaryActor,
} from "~/lib/glossary.server";
import { siteOrigin } from "~/lib/http/csrf.server";
import { getGlossaryVersion, glossaryVersionOf, loadGlossary, matchGlossary } from "~/lib/translations.server";
import { addMember, createTestDb } from "./helpers/db";

// Glossary revisions: create, update, delete and revive each record exactly one revision in the same transaction.

const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const op: GlossaryActor = { userId: "op", scope: { operator: true, langs: [] } };
const base = { term: "alignment", lang: "en", targetLang: "ja", candidates: "アラインメント\nアライメント", note: "AI safety", keepOriginal: false } as const;

async function setup() {
  const db = await createTestDb();
  await addMember(db, "op", "opal");
  await addMember(db, "u1", "hana");
  return db;
}
const revisions = (db: Db) => db.select().from(glossaryRevisions).orderBy(asc(glossaryRevisions.id));
const counts = async (db: Db) => [(await db.select().from(glossaryEntries)).length, (await revisions(db)).length];
const content = (over: Record<string, unknown> = {}) => ({ term: "alignment", candidates: ["アラインメント", "アライメント"], note: "AI safety", keepOriginal: false, needsReview: false, ...over });

describe("each write leaves exactly one revision", () => {
  it("add, change, delete and re-add: before, after, who, when and the source proposal; the chain of before and after is unbroken", async () => {
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "ja", title: "訳語の提案", body: "本文", asksStance: true });
    if (!topic.ok) throw new Error("topic failed");

    const made = await createGlossaryEntry(db, op, base, { now: t(1) });
    if (!made.ok) throw new Error("create failed");
    expect(made.revived).toBe(false);
    const first = await revisions(db);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ entryId: made.id, before: null, after: content(), editorId: "op", via: "admin", proposalEntryId: null });
    expect(first[0].createdAt).toEqual(t(1));

    // Update references the proposal by URL.
    const changed = await updateGlossaryEntry(db, op, made.id, { ...base, candidates: "アラインメント", note: "" }, { now: t(2), proposal: `${siteOrigin()}/t/${topic.id}?lang=ja#x` });
    expect(changed).toEqual({ ok: true, changed: true });
    // Delete references it by numeric ID.
    expect(await deleteGlossaryEntry(db, op, made.id, { now: t(3), proposal: String(topic.id) })).toEqual({ ok: true });
    // Reviving restores the same row and ID, continuing its history.
    const revived = await createGlossaryEntry(db, op, { ...base, note: "again" }, { now: t(4) });
    expect(revived).toEqual({ ok: true, id: made.id, revived: true });

    const all = await revisions(db);
    expect(all.map((r) => glossaryChangeKind(r))).toEqual(["created", "updated", "deleted", "created"]);
    expect(all.map((r) => r.proposalEntryId)).toEqual([null, topic.id, topic.id, null]);
    expect(all.map((r) => r.createdAt)).toEqual([t(1), t(2), t(3), t(4)]);
    expect(all[1]).toMatchObject({ before: content(), after: content({ candidates: ["アラインメント"], note: "" }), editorId: "op" });
    expect(all[2]).toMatchObject({ before: content({ candidates: ["アラインメント"], note: "" }), after: null });
    expect(all[3]).toMatchObject({ before: null, after: content({ note: "again" }) });
    // Revision chain: each before equals the preceding after; both are null between deletion and revival.
    all.slice(1).forEach((r, i) => expect(r.before, `revision ${i + 2}`).toEqual(all[i].after));
    // One row records the latest actor and timestamp. Deletion hides it and revival restores it.
    const rows = await db.select().from(glossaryEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: made.id, deletedAt: null, updatedBy: "op", note: "again" });
    expect(rows[0].updatedAt).toEqual(t(4));

    // Read newest first, returning actors as handles.
    const history = (await listGlossaryRevisions(db, [made.id])).get(made.id)!;
    expect(history.map((h) => h.kind)).toEqual(["created", "deleted", "updated", "created"]);
    expect(history[0]).toMatchObject({ editorHandle: "opal", proposalEntryId: null });
    expect(history[2].proposalEntryId).toBe(topic.id);
  });

  it("stores 'no content' as an SQL NULL, never as a JSON null", async () => {
    const db = await setup();
    const made = await createGlossaryEntry(db, op, base);
    if (!made.ok) throw new Error("create failed");
    await deleteGlossaryEntry(db, op, made.id);
    const [{ n: sqlNulls }] = await db.select({ n: sql<number>`count(*)::int` }).from(glossaryRevisions).where(sql`${glossaryRevisions.before} is null or ${glossaryRevisions.after} is null`);
    const [{ n: jsonNulls }] = await db.select({ n: sql<number>`count(*)::int` }).from(glossaryRevisions).where(sql`jsonb_typeof(${glossaryRevisions.before}) = 'null' or jsonb_typeof(${glossaryRevisions.after}) = 'null'`);
    expect(sqlNulls).toBe(2);
    expect(jsonNulls).toBe(0);
    // CHECK rejects a row with neither before nor after.
    await expect(db.insert(glossaryRevisions).values({ entryId: made.id, before: null, after: null })).rejects.toThrow();
  });

  it("a save that changes nothing writes no revision and does not touch updated_at (the proposal given with it is dropped)", async () => {
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    const made = await createGlossaryEntry(db, op, base, { now: t(1) });
    if (!made.ok) throw new Error("create failed");
    expect(await updateGlossaryEntry(db, op, made.id, base, { now: t(9), proposal: String(topic.id) })).toEqual({ ok: true, changed: false });
    expect(await revisions(db)).toHaveLength(1);
    expect((await db.select().from(glossaryEntries))[0].updatedAt).toEqual(t(1));
    // Reordering identical candidates is a change; order is content.
    expect(await updateGlossaryEntry(db, op, made.id, { ...base, candidates: "アライメント\nアラインメント" }, { now: t(2) })).toEqual({ ok: true, changed: true });
    // Changing only needs-review also records who verified it, without changing the glossary version.
    const version = await getGlossaryVersion(db);
    expect(await updateGlossaryEntry(db, op, made.id, { ...base, candidates: "アライメント\nアラインメント", needsReview: true }, { now: t(3) })).toEqual({ ok: true, changed: true });
    expect(await getGlossaryVersion(db)).toBe(version);
    expect(await revisions(db)).toHaveLength(3);
  });

  it("a write that fails (invalid proposal, duplicate, bad input, missing row) changes neither the entry nor the history", async () => {
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "r" });
    if (!reply.ok) throw new Error("reply failed");
    const a = await createGlossaryEntry(db, op, base, { now: t(1) });
    const b = await createGlossaryEntry(db, op, { ...base, term: "corrigibility" }, { now: t(1) });
    if (!a.ok || !b.ok) throw new Error("create failed");
    const before = JSON.stringify([await db.select().from(glossaryEntries).orderBy(asc(glossaryEntries.id)), await revisions(db)]);
    const unchanged = async () => JSON.stringify([await db.select().from(glossaryEntries).orderBy(asc(glossaryEntries.id)), await revisions(db)]);

    expect(await createGlossaryEntry(db, op, { ...base, term: "new" }, { proposal: String(reply.id) })).toEqual({ ok: false, error: "invalid_proposal" });
    expect(await updateGlossaryEntry(db, op, a.id, { ...base, note: "x" }, { proposal: "/t/99999" })).toEqual({ ok: false, error: "invalid_proposal" });
    expect(await deleteGlossaryEntry(db, op, a.id, { proposal: "https://evil.example/t/1" })).toEqual({ ok: false, error: "invalid_proposal" });
    // Reject invalid references even if content is unchanged.
    expect(await updateGlossaryEntry(db, op, a.id, base, { proposal: "abc" })).toEqual({ ok: false, error: "invalid_proposal" });
    // Renaming the term collides with another row's key, including deleted rows.
    expect(await updateGlossaryEntry(db, op, a.id, { ...base, term: "corrigibility" })).toEqual({ ok: false, error: "duplicate" });
    expect(await createGlossaryEntry(db, op, { ...base, term: "corrigibility" })).toEqual({ ok: false, error: "duplicate" });
    expect(await createGlossaryEntry(db, op, { ...base, term: "" })).toEqual({ ok: false, error: "invalid_term" });
    expect(await updateGlossaryEntry(db, op, 9999, base)).toEqual({ ok: false, error: "not_found" });
    expect(await deleteGlossaryEntry(db, op, 9999)).toEqual({ ok: false, error: "not_found" });
    expect(await unchanged()).toBe(before);

    // An update colliding with a deleted row is duplicate; revival happens only through creation.
    expect(await deleteGlossaryEntry(db, op, b.id, { now: t(5) })).toEqual({ ok: true });
    const afterDelete = await unchanged();
    expect(await updateGlossaryEntry(db, op, a.id, { ...base, term: "corrigibility" })).toEqual({ ok: false, error: "duplicate" });
    expect(await unchanged()).toBe(afterDelete);
    // Updating or deleting an already-deleted entry yields not_found.
    expect(await deleteGlossaryEntry(db, op, b.id)).toEqual({ ok: false, error: "not_found" });
    expect(await updateGlossaryEntry(db, op, b.id, { ...base, term: "corrigibility" })).toEqual({ ok: false, error: "not_found" });
  });

  it("the language of the term and the target language are fixed after the entry is made (lang_fixed); the same values, or none, are accepted", async () => {
    const db = await setup();
    const made = await createGlossaryEntry(db, op, base, { now: t(1) });
    if (!made.ok) throw new Error("create failed");
    const before = await counts(db);
    expect(await updateGlossaryEntry(db, op, made.id, { ...base, lang: "fr" })).toEqual({ ok: false, error: "lang_fixed" });
    expect(await updateGlossaryEntry(db, op, made.id, { ...base, targetLang: "fr" })).toEqual({ ok: false, error: "lang_fixed" });
    expect(await updateGlossaryEntry(db, op, made.id, { ...base, lang: "xx" })).toEqual({ ok: false, error: "lang_fixed" });
    expect(await counts(db)).toEqual(before);
    expect(await updateGlossaryEntry(db, op, made.id, { term: "alignment", candidates: "x" })).toEqual({ ok: true, changed: true });
    expect(await updateGlossaryEntry(db, op, made.id, { term: "alignment", lang: "en", targetLang: "ja", candidates: "y" })).toEqual({ ok: true, changed: true });
  });
});

describe("a deleted entry stays as a row, and is used by neither the translation nor the glossary version", () => {
  it("is left out of loadGlossary and getGlossaryVersion and of the prompt; deleting changes the version, and adding the same content again brings the same row and the same version back", async () => {
    const db = await setup();
    const a = await createGlossaryEntry(db, op, base, { now: t(1) });
    const b = await createGlossaryEntry(db, op, { ...base, term: "corrigibility", candidates: "修正可能性", note: "" }, { now: t(1) });
    if (!a.ok || !b.ok) throw new Error("create failed");
    const withBoth = await getGlossaryVersion(db);
    expect((await loadGlossary(db, "en", "ja")).map((r) => r.term)).toEqual(["alignment", "corrigibility"]);
    expect(await deleteGlossaryEntry(db, op, a.id, { now: t(2) })).toEqual({ ok: true });
    // Retain the row with deleted_at.
    expect((await db.select().from(glossaryEntries)).find((r) => r.id === a.id)?.deletedAt).toEqual(t(2));
    expect((await loadGlossary(db, "en", "ja")).map((r) => r.term)).toEqual(["corrigibility"]);
    expect(matchGlossary(await loadGlossary(db, "en", "ja"), "alignment and corrigibility").map((h) => h.term)).toEqual(["corrigibility"]);
    const withOne = await getGlossaryVersion(db);
    expect(withOne).not.toBe(withBoth);
    expect(withOne).toBe(glossaryVersionOf([{ term: "corrigibility", lang: "en", targetLang: "ja", candidates: ["修正可能性"], note: "", keepOriginal: false }]));
    // Separate active and deleted lists.
    expect((await listGlossary(db)).entries.map((e) => e.term)).toEqual(["corrigibility"]);
    expect((await listGlossary(db, { deleted: true })).entries.map((e) => [e.id, e.term, e.deletedAt])).toEqual([[a.id, "alignment", t(2)]]);
    // Deleting all entries makes the version null.
    await deleteGlossaryEntry(db, op, b.id, { now: t(3) });
    expect(await getGlossaryVersion(db)).toBeNull();
    // Re-adding identical content revives the same ID and restores the original version, independent of timestamps and IDs.
    expect(await createGlossaryEntry(db, op, base, { now: t(4) })).toEqual({ ok: true, id: a.id, revived: true });
    expect(await createGlossaryEntry(db, op, { ...base, term: "corrigibility", candidates: "修正可能性", note: "" }, { now: t(4) })).toEqual({ ok: true, id: b.id, revived: true });
    expect(await getGlossaryVersion(db)).toBe(withBoth);
    expect((await db.select().from(glossaryEntries)).length).toBe(2);
  });
});

describe("the proposal post that a change refers to", () => {
  it("takes a number, a /t/<id> path or a full URL of this site (with ?lang= or #…), and nothing else", async () => {
    const db = await setup();
    const topic = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" });
    const plain = await createTopic(db, "u1", { lang: "ja", title: "p", body: "b", asksStance: true });
    const hiddenTopic = await createTopic(db, "u1", { lang: "ja", title: "h", body: "b" });
    const deletedTopic = await createTopic(db, "u1", { lang: "ja", title: "d", body: "b" });
    if (!topic.ok || !plain.ok || !hiddenTopic.ok || !deletedTopic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "r" });
    if (!reply.ok) throw new Error("reply failed");
    await db.update(entries).set({ hiddenAt: t(0) }).where(eq(entries.id, hiddenTopic.id));
    await db.update(entries).set({ deletedAt: t(0) }).where(eq(entries.id, deletedTopic.id));
    const origin = siteOrigin();
    const ok = async (raw: unknown) => resolveProposal(db, raw);
    // Absent.
    for (const empty of [undefined, null, "", "  "]) expect(await ok(empty)).toEqual({ ok: true, entryId: null });
    // Accepted inputs need not be stance questions.
    for (const raw of [String(topic.id), ` ${topic.id} `, topic.id, `/t/${topic.id}`, `${origin}/t/${topic.id}`, `${origin}/t/${topic.id}/`, `${origin}/t/${topic.id}?lang=en#c-1`, `${origin}/t/${topic.id}?page=2`]) {
      expect(await ok(raw), String(raw)).toEqual({ ok: true, entryId: topic.id });
    }
    expect(await ok(plain.id)).toEqual({ ok: true, entryId: plain.id });
    // Reject replies, hidden/deleted topics, missing IDs, other sites, non-topic paths and nonnumeric IDs.
    const bad = [
      String(reply.id),
      `${origin}/t/${reply.id}`,
      String(hiddenTopic.id),
      String(deletedTopic.id),
      "99999",
      "0",
      "-1",
      "abc",
      "1.5",
      "1e3",
      `https://evil.example/t/${topic.id}`,
      `http://localhost:1/t/${topic.id}`,
      `//evil.example/t/${topic.id}`,
      `${origin}/c/${topic.id}`,
      `${origin}/t/${topic.id}.md`,
      `${origin}/t/${topic.id}/edit`,
      `${origin}/t/abc`,
      "javascript:alert(1)",
      "1234567890123456789",
    ];
    for (const raw of bad) expect(await ok(raw), raw).toEqual({ ok: false, error: "invalid_proposal" });
    for (const raw of [{}, [1], true]) expect(await ok(raw)).toEqual({ ok: false, error: "invalid_proposal" });
  });
});

// ---- Source scan ----

describe("the code that writes the glossary", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const sources = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "paraglide" ? [] : sources(rel);
      return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
    });
  const files = [...sources("app"), ...sources("scripts")].filter((f) => !f.endsWith(path.join("db", "schema.ts")));
  const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
  const matching = (pattern: RegExp) => files.filter((f) => pattern.test(read(f))).sort();

  it("writes glossary_entries and glossary_revisions only in app/lib/glossary.server.ts (no write skips the history)", () => {
    const writes = /\.(?:insert|update|delete)\(\s*glossary(?:Entries|Revisions)\b/;
    expect(matching(writes)).toEqual([path.join("app", "lib", "glossary.server.ts")]);
    // No writes through raw SQL either.
    expect(matching(/(?:insert\s+into|update|delete\s+from)\s+"?glossary_(?:entries|revisions)"?/i)).toEqual([]);
  });

  it("reads glossary_entries only in glossary.server.ts and translations.server.ts (the condition that leaves out deleted entries is not forgotten)", () => {
    expect(matching(/\bglossaryEntries\b/)).toEqual([path.join("app", "lib", "glossary.server.ts"), path.join("app", "lib", "translations.server.ts")]);
    // No reads through raw SQL either.
    expect(matching(/(?:from|join)\s+"?glossary_entries"?/i)).toEqual([]);
  });

  it("does not read the stance tables: no count of stances can decide what the glossary says", () => {
    const checked = ["app/lib/glossary.server.ts", "app/lib/glossary-page.server.ts", "app/lib/glossary-io.server.ts", "app/lib/glossary-proposal.server.ts", "app/lib/md/glossary.server.ts"].filter((f) => fs.existsSync(path.join(root, f)));
    expect(checked).toContain("app/lib/glossary.server.ts");
    // Only the code counts: a comment may say that it does not read stances
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const f of checked) expect(code(f), f).not.toMatch(/\bstances\b|stance_changes|stanceChanges/);
  });

  it("reads the revisions of an entry that has none (an empty list), and every revision row has the entry as its foreign key", async () => {
    const db = await setup();
    const made = await createGlossaryEntry(db, op, base);
    if (!made.ok) throw new Error("create failed");
    expect((await listGlossaryRevisions(db, [made.id, 12345])).get(12345)).toEqual([]);
    expect(await listGlossaryRevisions(db, [])).toEqual(new Map());
    await expect(db.insert(glossaryRevisions).values({ entryId: 9999, before: null, after: content() })).rejects.toThrow();
    expect(await db.select().from(glossaryRevisions).where(and(eq(glossaryRevisions.entryId, made.id)))).toHaveLength(1);
  });
});
