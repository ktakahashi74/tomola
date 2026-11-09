import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { entries, entryReferences, profiles, translations, villages } from "~/lib/db/schema";
import { getThread, listTopics } from "~/lib/entries.server";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { exportSite } from "~/lib/site-export.server";
import { setVote } from "~/lib/votes.server";
import { listAlternativeRefs } from "~/lib/objections.server";
import { deleteMedia, putMedia } from "~/lib/media-store.server";
import { addMember, createTestDb } from "./helpers/db";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("~/lib/media", async original => {
  const module = await original<typeof import("~/lib/media")>();
  return { ...module, MEDIA_LIMITS: { ...module.MEDIA_LIMITS, memberStoredBytes: 16, siteStoredBytes: 24 } };
});

it("moves activity indexes off entries and supports ordered replies and job entity lookups", async () => {
  const db = await createTestDb();
  const result = await db.execute(sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`) as { rows: { indexname: string; indexdef: string }[] };
  const definitions = new Map(result.rows.map(row => [row.indexname, row.indexdef]));
  expect(result.rows.filter(row => row.indexdef.includes('ON public.entries ') && row.indexdef.includes('last_activity_at'))).toEqual([]);
  expect(definitions.get("entries_thread_idx")).toContain("(thread_id, created_at, id)");
  expect(definitions.get("jobs_entry_idx")).toContain("entryId");
  expect(definitions.get("jobs_message_idx")).toContain("messageId");
  expect(definitions.get("jobs_kind_dedupe_idx")).toContain("(kind, dedupe_key)");
});

it("keeps topic counts current for votes, withdrawals and reaction exclusion without grouping votes in listings", async () => {
  const queries: string[] = [];
  const db = await createTestDb({ logger: { logQuery(query) { queries.push(query); } } });
  await addMember(db, "shape_writer", "shape_writer");
  await addMember(db, "shape_voter", "shape_voter");
  const [older, newer] = await db.insert(entries).values([0, 1].map(i => ({ kind: "topic", authorId: "shape_writer", lang: "en", body: `Topic ${i}`, createdAt: new Date(2030, 0, i + 1) }))).returning();
  const first = async () => (await listTopics(db, { kind: "all" }, { order: "insightful" })).topics[0].id;
  expect(await first()).toBe(newer.id);
  await setVote(db, "shape_voter", older.id, true);
  queries.length = 0;
  expect(await first()).toBe(older.id);
  expect(queries.join("\n")).not.toMatch(/(?:from|join)\s+"votes"/i);
  await db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "shape_voter"));
  expect(await first()).toBe(newer.id);
  await db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "shape_voter"));
  expect(await first()).toBe(older.id);
  await setVote(db, "shape_voter", older.id, false);
  expect(await first()).toBe(newer.id);
});

it("excludes closed-village topics, replies and translations from every public reading path, including a signed-in reader", async () => {
  const db = await createTestDb();
  await addMember(db, "place_writer", "place_writer");
  const [village] = await db.insert(villages).values({ kind: "closed", slug: "closed-place" }).returning();
  const [closed, open] = await db.insert(entries).values([
    { kind: "topic", authorId: "place_writer", villageId: village.id, lang: "en", title: "private-place-title", body: "private-place-body", sourceHash: "h", asksStance: true },
    { kind: "topic", authorId: "place_writer", lang: "en", title: "Public topic", body: "Public body", asksStance: true },
  ]).returning();
  await db.update(entries).set({ altOf: open.id }).where(eq(entries.id, closed.id));
  const [reply] = await db.insert(entries).values({ kind: "reply", threadId: closed.id, authorId: "place_writer", lang: "en", body: "private-place-reply" }).returning();
  await db.insert(translations).values({ entryId: reply.id, field: "body", lang: "ja", kind: "primary", text: "private-place-translation", sourceHash: "h" });
  await db.insert(entryReferences).values({ sourceEntryId: open.id, targetEntryId: reply.id });
  expect((await listTopics(db)).topics.map(row => row.id)).toEqual([open.id]);
  expect(await getThread(db, closed.id, { viewer: { userId: "place_writer", scope: { operator: true, langs: [] } } })).toBeNull();
  expect(await buildThreadMarkdown(db, closed.id, { page: 1, lang: "en", sentences: false, k: null, readerId: "place_writer" })).toBeNull();
  expect((await listRelatedDiscussions(db, open.id, { readLangs: ["en"], displayLang: "en" })).rows).toEqual([]);
  expect(await listAlternativeRefs(db, open.id)).toEqual([]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "closed-place-export-"));
  try {
    const outDir = path.join(temp, "site");
    await exportSite(db, { outDir, langs: ["en"] });
    const files = await fs.readdir(outDir, { recursive: true, withFileTypes: true });
    for (const file of files.filter(file => file.isFile())) {
      expect(await fs.readFile(path.join(file.parentPath, file.name), "utf8")).not.toContain("private-place-");
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

const image = (value: string) => ({ bytes: Buffer.from(value), width: 1, height: 1 });
it("enforces member byte quotas at the exact boundary, deduplicates free of charge and frees deleted bytes", async () => {
  const db = await createTestDb();
  await addMember(db, "quota_writer", "quota_writer");
  const first = await putMedia(db, "quota_writer", image("12345678"));
  await putMedia(db, "quota_writer", image("abcdefgh"));
  expect(await putMedia(db, "quota_writer", image("12345678"))).toEqual(first);
  await expect(putMedia(db, "quota_writer", image("x"))).rejects.toMatchObject({ code: "member_bytes", status: 409 });
  await deleteMedia(db, first.url.split("/").at(-1)!.slice(0, 64));
  await expect(putMedia(db, "quota_writer", image("x"))).resolves.toBeDefined();
});

it("enforces the shared site byte quota across different uploaders", async () => {
  const db = await createTestDb();
  for (const id of ["site_one", "site_two", "site_three"]) await addMember(db, id, id);
  await putMedia(db, "site_one", image("123456789012"));
  await putMedia(db, "site_two", image("abcdefghijkl"));
  await expect(putMedia(db, "site_three", image("x"))).rejects.toMatchObject({ code: "site_bytes", status: 409 });
});
