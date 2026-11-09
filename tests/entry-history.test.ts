import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appeals, entries, entryMentionSnapshots, entryRevisions, jobs, memberSignatures, moderationActions, profiles, reports, translationRevisions, translations, villages, votes } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { deleteEntryRevision, EDIT_GRACE_MS, readEntryHistory } from "~/lib/entry-history.server";
import { historyDiff } from "~/lib/history-diff.server";
import { buildHistoryMarkdown } from "~/lib/md/history.server";
import { buildMemberExport } from "~/lib/exports.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { buildChangesMarkdown } from "~/lib/md/changes.server";
import { exportSite } from "~/lib/site-export.server";
import { setVote } from "~/lib/votes.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { fixEntry } from "~/lib/moderation.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { attachSigningProof, signingCredential } from "./helpers/signing";
import { PG_MODE } from "./helpers/pg-test";
import { parseBlocks } from "./helpers/md";

let h: RouteHarness, author: string, reader: string, operator: string;
const start = new Date("2026-10-01T00:00:00Z");
const at = (ms: number) => new Date(start.getTime() + ms);
const minute = (n: number) => at(n * 60_000);
const body = "First sentence.\n\nSecond paragraph.";
let seq = 0;
async function topic() {
  const result = await createTopic(h.db, author, { title: `History source ${++seq}`, body, lang: "en" }, { now: start });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function edit(id: number, text: string, now = minute(31), kind: "topic" | "reply" = "topic") {
  const result = await editEntry(h.db, author, id, { title: kind === "topic" ? "Revised title" : null, body: text }, { now, kind });
  expect(result).toMatchObject({ ok: true, changed: true });
}
const revisions = (id: number) => h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id));

beforeAll(async () => {
  h = await setupRouteHarness();
  author = await h.signIn("history_author"); reader = await h.signIn("history_reader"); operator = await h.signIn("history_operator");
});
afterAll(() => { vi.unstubAllEnvs(); h.restore(); });

describe("published edit history", () => {
  it("coalesces edits strictly before 30 minutes while retaining source jobs and mention updates", async () => {
    const id = await topic();
    await edit(id, "First correction. @history_reader", minute(10));
    await edit(id, "Second correction. @history_reader", at(EDIT_GRACE_MS - 1));
    expect(await revisions(id)).toEqual([]);
    const [row] = await h.db.select().from(entries).where(eq(entries.id, id));
    expect(row.editedAt).toBeNull(); expect(row.mentionRevision).toBe(2); expect(row.sourceHash).toBeTruthy();
    expect((await h.db.select().from(jobs)).some(j => (j.payload as { entryId?: number }).entryId === id)).toBe(true);
    await edit(id, "At the boundary.", at(EDIT_GRACE_MS));
    expect((await revisions(id)).map(r => r.body)).toEqual(["Second correction. @history_reader"]);
    const history = await readEntryHistory(h.db, id, null, "current");
    expect(history?.versions.map(v => v.at)).toEqual([start.toISOString(), at(EDIT_GRACE_MS).toISOString()]);
    expect(history?.selected?.previous?.body).toBe("Second correction. @history_reader");
  });

  it.each(["reply", "vote"])("ends grace irreversibly after the first %s, including its removal", async reaction => {
    const id = await topic();
    if (reaction === "reply") {
      const reply = await createReply(h.db, reader, id, { body: "A response.", lang: "en" }, { now: minute(1) });
      if (!reply.ok) throw new Error(reply.error);
      await softDeleteEntry(h.db, reply.id, { now: minute(2) });
    } else {
      expect(await setVote(h.db, reader, id, true, { now: minute(1) })).toMatchObject({ ok: true });
      await setVote(h.db, reader, id, false, { now: minute(2) });
    }
    await edit(id, "After engagement.", minute(3));
    expect(await revisions(id)).toHaveLength(1);
  });

  it("preserves a reaction recorded before the history latch when it is removed", async () => {
    const id = await topic();
    await h.db.insert(votes).values({ entryId: id, voterId: reader, voterArea: "ja", createdAt: minute(1) });
    expect(await setVote(h.db, reader, id, false, { now: minute(2) })).toMatchObject({ ok: true, changed: true });
    const [row] = await h.db.select().from(entries).where(eq(entries.id, id));
    expect(row.historyStartedAt).toEqual(minute(1));
    await edit(id, "After removing an existing reaction.", minute(3));
    expect(await revisions(id)).toHaveLength(1);
  });

  it("uses the same rules on replies, including replies to replies", async () => {
    const id = await topic();
    const reply = await createReply(h.db, author, id, { body: "Initial reply.", lang: "en" }, { now: start });
    if (!reply.ok) throw new Error(reply.error);
    await edit(reply.id, "Corrected reply.", minute(1), "reply");
    expect(await revisions(reply.id)).toEqual([]);
    const child = await createReply(h.db, reader, id, { body: "Child response.", lang: "en", parentId: reply.id }, { now: minute(2) });
    expect(child.ok).toBe(true);
    await edit(reply.id, "Reply after engagement.", minute(3), "reply");
    const history = await readEntryHistory(h.db, reply.id, null, "current");
    expect(history?.path).toBe(`/c/${reply.id}/history`);
    expect(history?.selected?.previous?.body).toBe("Corrected reply.");
  });

  it("leaves tombstones, removes source snapshots, and compares surviving versions only", async () => {
    const id = await topic();
    await edit(id, "Middle secret."); await edit(id, "Current text.", minute(32));
    const [first, middle] = await revisions(id);
    expect(await deleteEntryRevision(h.db, reader, id, middle.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteEntryRevision(h.db, author, id, middle.id)).toEqual({ ok: true });
    const index = await readEntryHistory(h.db, id, null);
    expect(index?.versions.find(v => v.id === String(middle.id))?.deleted).toBe(true);
    expect(JSON.stringify(index)).not.toContain("Middle secret");
    expect((await readEntryHistory(h.db, id, null, String(middle.id)))?.selected).toBeNull();
    expect((await readEntryHistory(h.db, id, null, "current"))?.selected?.previous?.body).toBe(body);
    const stored = (await revisions(id)).find(r => r.id === middle.id)!;
    expect(stored).toMatchObject({ title: null, body: "" }); expect(stored.deletedAt).not.toBeNull();
    expect(await h.db.select().from(entryMentionSnapshots).where(and(eq(entryMentionSnapshots.entryId, id), eq(entryMentionSnapshots.revision, middle.mentionRevision)))).toEqual([]);
    const md = await buildHistoryMarkdown(h.db, id, String(middle.id), null, null);
    expect(md).toContain("deleted: true"); expect(md).not.toContain("Middle secret");
    const current = await buildHistoryMarkdown(h.db, id, "current", null, null);
    expect(current).toContain("revision_diff"); expect(current).not.toContain("Middle secret");
    const exported = await buildMemberExport(h.db, author);
    expect(exported.entries.find(e => e.id === id)?.revisions.find(r => r.deleted_at)?.body).toBe("");
    expect(await deleteEntryRevision(h.db, author, id, first.id + 100_000)).toEqual({ ok: false, error: "not_found" });
  });

  it("erases signed copies of a removed source while retaining current-source signatures", async () => {
    const id = await topic();
    const [original] = await h.db.select().from(entries).where(eq(entries.id, id));
    await edit(id, "Current signed source.");
    const [current] = await h.db.select().from(entries).where(eq(entries.id, id));
    const insert = (hash: string, text: string, suffix: string) => h.db.insert(memberSignatures).values({
      userId: author, entryId: id, sourceHash: hash, operation: "post-topic", payload: JSON.stringify({ body: text }), payloadHash: "fixture",
      challenge: `history-${id}-${suffix}`, credentialId: "fixture", publicKey: "fixture", rpId: "localhost", origin: "http://localhost",
      assertion: {}, authenticatorData: "fixture", clientDataJson: "{}", signature: "fixture",
    });
    await insert(original.sourceHash!, original.body, "original");
    await insert(current.sourceHash!, current.body, "current");
    const [revision] = await revisions(id);
    expect(await deleteEntryRevision(h.db, author, id, revision.id)).toEqual({ ok: true });
    expect((await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, id))).map(s => s.sourceHash)).toEqual([current.sourceHash]);
  });

  it("removes retired translations from readers, Markdown, exports and feeds with their source", async () => {
    const id = await topic();
    const [original] = await h.db.select().from(entries).where(eq(entries.id, id));
    const retired = ["Retired human title", "Retired human body"].map(text => `${text} ${id}`);
    await h.db.insert(translations).values(["title", "body"].map((field, i) => ({ entryId: id, field, lang: "ja", kind: "human", text: retired[i], sourceHash: original.sourceHash, mentionRevision: original.mentionRevision, createdBy: author })));
    await h.db.insert(translationRevisions).values({ entryId: id, field: "body", lang: "ja", kind: "human", text: retired[1], sourceHash: original.sourceHash, createdAt: start, reason: "human_edit" });
    await edit(id, "Current translated source.");
    const [current] = await h.db.select().from(entries).where(eq(entries.id, id));
    await h.db.insert(translations).values({ entryId: id, field: "body", lang: "fr", kind: "human", text: "Current human translation", sourceHash: current.sourceHash });
    await h.db.insert(translationRevisions).values({ entryId: id, field: "body", lang: "fr", kind: "human", text: "Current translation history", sourceHash: current.sourceHash, createdAt: minute(31), reason: "human_edit" });
    const options = { page: 1, lang: "ja" as const, sentences: true, k: null };
    expect(await buildThreadMarkdown(h.db, id, options)).toContain(retired[1]);
    const [revision] = await revisions(id);
    expect(await deleteEntryRevision(h.db, author, id, revision.id)).toEqual({ ok: true });
    expect((await h.db.select().from(translations).where(eq(translations.entryId, id))).map(t => t.sourceHash)).toEqual([current.sourceHash]);
    expect((await h.db.select().from(translationRevisions).where(eq(translationRevisions.entryId, id))).map(t => t.sourceHash)).toEqual([current.sourceHash]);
    const route = await import("~/routes/topic");
    const outputs = [
      ...await Promise.all(["?lang=ja", "?lang=ja&old=ja"].map(query => route.loader(h.args(h.request(`/t/${id}${query}`, { as: "history_reader" }), { id: String(id) })))),
      await readEntryHistory(h.db, id, reader, String(revision.id), true),
      await readEntryHistory(h.db, id, reader, "current", true),
      await buildThreadMarkdown(h.db, id, options), // MCP uses this same builder.
      await buildHistoryMarkdown(h.db, id, String(revision.id), reader, null),
      await buildHistoryMarkdown(h.db, id, "current", reader, null),
      (await buildMemberExport(h.db, author)).entries.find(e => e.id === id),
      await buildChangesMarkdown(h.db, { since: null, k: null }),
    ];
    for (const output of outputs) for (const text of [...retired, original.title!]) expect(JSON.stringify(output)).not.toContain(text);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "history-erasure-"));
    try {
      await exportSite(h.db, { outDir: path.join(temporary, "site"), langs: ["ja", "en"] });
      for (const extension of ["html", "md"]) {
        const document = await fs.readFile(path.join(temporary, "site", "ja", "t", `${id}.${extension}`), "utf8");
        for (const text of [...retired, original.title!]) expect(document).not.toContain(text);
      }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    vi.stubEnv("PUBLIC_READING", "1");
    try {
      const { handlePublicMcpRequest } = await import("~/lib/mcp/server.server");
      const baseURL = "https://forum.example.org";
      const response = await handlePublicMcpRequest(new Request(`${baseURL}/mcp/public`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_thread", arguments: { id, lang: "ja" } } }),
      }), { db: h.db, baseURL });
      expect(response.status).toBe(200);
      const result = await response.text();
      expect(result).toContain("Current translated source.");
      for (const text of [...retired, original.title!]) expect(result).not.toContain(text);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["surviving", "current"])("retains translations while a %s version still uses their source", async kept => {
    const id = await topic();
    const [original] = await h.db.select().from(entries).where(eq(entries.id, id));
    await edit(id, "Intervening source.");
    expect(await editEntry(h.db, author, id, { title: original.title, body: original.body }, { now: minute(32) })).toMatchObject({ ok: true });
    if (kept === "surviving") await edit(id, "Final source.", minute(33));
    await h.db.insert(translations).values({ entryId: id, field: "body", lang: "ja", kind: "human", text: "Shared source translation", sourceHash: original.sourceHash });
    await h.db.insert(translationRevisions).values({ entryId: id, field: "body", lang: "ja", kind: "human", text: "Shared translation history", sourceHash: original.sourceHash, createdAt: start, reason: "human_edit" });
    const [first, , repeated] = await revisions(id);
    expect(await deleteEntryRevision(h.db, author, id, first.id)).toEqual({ ok: true });
    expect(await h.db.select().from(translations).where(eq(translations.entryId, id))).toHaveLength(1);
    expect(await h.db.select().from(translationRevisions).where(eq(translationRevisions.entryId, id))).toHaveLength(1);
    if (repeated) {
      expect(await deleteEntryRevision(h.db, author, id, repeated.id)).toEqual({ ok: true });
      expect(await h.db.select().from(translations).where(eq(translations.entryId, id))).toEqual([]);
      expect(await h.db.select().from(translationRevisions).where(eq(translationRevisions.entryId, id))).toEqual([]);
    }
  });

  it.each(["topic", "reply", "root"])("preserves edits during grace and prevents deletion while the %s is hidden", async hidden => {
    const id = await topic();
    const reply = hidden === "topic" ? null : await createReply(h.db, author, id, { body: "Hidden reply source.", lang: "en" }, { now: start });
    if (reply && !reply.ok) throw new Error(reply.error);
    const target = reply?.id ?? id;
    await h.db.update(entries).set({ hiddenAt: minute(1) }).where(eq(entries.id, hidden === "reply" ? target : id));
    await edit(target, "Edited during hiding.", minute(2), hidden === "topic" ? "topic" : "reply");
    const [revision] = await revisions(target);
    expect(revision.body).toBe(hidden === "topic" ? body : "Hidden reply source.");
    expect((await readEntryHistory(h.db, target, author, String(revision.id), true))?.selected?.protected).toBe(true);
    expect(await deleteEntryRevision(h.db, author, target, revision.id)).toEqual({ ok: false, error: "protected" });
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, hidden === "reply" ? target : id));
    expect(await deleteEntryRevision(h.db, author, target, revision.id)).toEqual({ ok: true });
  });

  it.each(["topic", "reply"] as const)("preserves a reported %s during grace without exposing the report through deletion controls", async kind => {
    const id = await topic();
    const reply = kind === "reply" ? await createReply(h.db, author, id, { body: "Reported reply.", lang: "en" }, { now: start }) : null;
    if (reply && !reply.ok) throw new Error(reply.error);
    const target = reply?.id ?? id;
    await h.db.insert(reports).values({ entryId: target, reporterId: reader, reason: "spam" });
    await edit(target, "Edited after a report.", minute(2), kind);
    const [revision] = await revisions(target);
    expect(revision).toBeDefined();
    expect((await readEntryHistory(h.db, target, author, String(revision.id), true))?.selected?.protected).toBe(false);
    expect(await deleteEntryRevision(h.db, author, target, revision.id)).toEqual({ ok: true });
  });

  it("protects every version during an open appeal about a hide even after visibility is restored", async () => {
    const id = await topic();
    await edit(id, "After the hide.");
    const [action] = await h.db.insert(moderationActions).values({ targetEntryId: id, action: "hide", actorId: operator, reason: "spam" }).returning();
    const [appeal] = await h.db.insert(appeals).values({ actionId: action.id, appellantId: author, text: "Review the hide." }).returning();
    await edit(id, "After another edit.", minute(32));
    for (const revision of await revisions(id)) {
      expect((await readEntryHistory(h.db, id, author, String(revision.id), true))?.selected?.protected).toBe(true);
      expect(await deleteEntryRevision(h.db, author, id, revision.id)).toEqual({ ok: false, error: "protected" });
    }
    await h.db.update(appeals).set({ status: "upheld", decidedBy: reader, decidedAt: minute(33), decisionNote: "Reviewed." }).where(eq(appeals.id, appeal.id));
    for (const revision of await revisions(id)) expect(await deleteEntryRevision(h.db, author, id, revision.id)).toEqual({ ok: true });
  });

  it("withholds histories of hidden/deleted posts, deleted roots and closed villages", async () => {
    const id = await topic(); await edit(id, "Updated.");
    expect(await readEntryHistory(h.db, id, null)).not.toBeNull();
    await h.db.update(entries).set({ hiddenAt: minute(33) }).where(eq(entries.id, id));
    expect(await readEntryHistory(h.db, id, null)).toBeNull();
    expect(await readEntryHistory(h.db, id, reader, undefined, true)).toBeNull();
    expect(await readEntryHistory(h.db, id, author, undefined, true)).not.toBeNull();
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, id));
    const [closed] = await h.db.insert(villages).values({ slug: `history-closed-${id}`, name: "Closed", kind: "closed", createdBy: author }).returning();
    await h.db.update(entries).set({ villageId: closed.id }).where(eq(entries.id, id));
    expect(await readEntryHistory(h.db, id, author)).toBeNull();
    await h.db.update(entries).set({ villageId: null }).where(eq(entries.id, id));
    const reply = await createReply(h.db, author, id, { body: "Reply.", lang: "en" }, { now: start });
    if (!reply.ok) throw new Error(reply.error);
    await softDeleteEntry(h.db, id);
    expect(await readEntryHistory(h.db, id, author)).toBeNull();
    expect(await readEntryHistory(h.db, reply.id, author)).toBeNull();
    expect(await buildHistoryMarkdown(h.db, id, "current", author, null)).toBeNull();
  });

  it("protects moderation evidence until its appeal is decided and preserves question locking", async () => {
    const q = await createTopic(h.db, author, { title: "Pinned question", body, lang: "en", asksStance: true }, { now: start });
    if (!q.ok) throw new Error(q.error);
    await h.db.update(entries).set({ stanceLockedAt: minute(1) }).where(eq(entries.id, q.id));
    expect(await editEntry(h.db, author, q.id, { title: "Changed question", body: "Changed." }, { now: minute(2) })).toMatchObject({ ok: false, error: "locked" });
    const [row] = await h.db.select().from(entries).where(eq(entries.id, q.id));
    const fixed = await fixEntry(h.db, { id: operator, scope: { operator: true, langs: [] } }, { entryId: q.id, title: row.title, body: "Corrected spelling.", sourceHash: row.sourceHash, note: "Spelling." }, { now: minute(2) });
    if (!fixed.ok) throw new Error(fixed.error);
    expect(await deleteEntryRevision(h.db, author, q.id, fixed.revisionId)).toEqual({ ok: false, error: "protected" });
    const appeal = await createAppeal(h.db, author, fixed.actionId, "Review the correction.");
    if (!appeal.ok) throw new Error(appeal.error);
    expect(await deleteEntryRevision(h.db, author, q.id, fixed.revisionId)).toEqual({ ok: false, error: "protected" });
    expect(await decideAppeal(h.db, { id: reader, scope: { operator: true, langs: [] } }, appeal.id, { decision: "upheld", note: "Correction stands." })).toMatchObject({ ok: true });
    expect(await deleteEntryRevision(h.db, author, q.id, fixed.revisionId)).toEqual({ ok: true });
  });

  it("gates anonymous HTML and Markdown, and requires author confirmation and same origin for deletion", async () => {
    const id = await topic(); await edit(id, "Current browser text.");
    const [revision] = await revisions(id);
    const route = await import("~/routes/entry-history");
    const md = await import("~/routes/entry-history-md");
    vi.stubEnv("PUBLIC_READING", "");
    expect(await h.outcome(() => route.loader(h.args(h.request(`/t/${id}/history`), { id: String(id) })))).toMatchObject({ status: 302 });
    const denied = await md.loader(h.args(h.request(`/t/${id}/history.md`), { id: String(id) }));
    expect(denied.status).toBe(401);
    vi.stubEnv("PUBLIC_READING", "1");
    const result = await route.loader(h.args(h.request(`/t/${id}/history`), { id: String(id) }));
    expect(result.history.owner).toBe(false);
    const response = await md.loader(h.args(h.request(`/t/${id}/history.md`), { id: String(id) }));
    expect(response.status).toBe(200); expect(parseBlocks(await response.text())[0].fm.versions).toBeDefined();
    expect((await md.loader(h.args(h.request(`/c/${id}/history.md`), { id: String(id) }))).status).toBe(404);
    const args = (form: Record<string, string>, as = "history_author", headers = {}) => h.args(h.request(`/t/${id}/history/${revision.id}`, { as, form, headers }), { id: String(id), version: String(revision.id) });
    expect(await h.outcome(() => route.action(args({})))).toMatchObject({ status: 400 });
    expect(await h.outcome(() => route.action(args({ confirm: "delete" }, "history_reader")))).toMatchObject({ status: 403 });
    expect(await h.outcome(() => route.action(args({ confirm: "delete" }, "history_author", { origin: "https://foreign.invalid" })))).toMatchObject({ status: 403 });
    const deletion = h.args(h.request(`/t/${id}/history/${revision.id}.data?delete=1`, { as: "history_author", form: { confirm: "delete" } }), { id: String(id), version: String(revision.id) });
    expect(await h.outcome(() => route.action(deletion))).toMatchObject({ status: 302, location: `/t/${id}/history/${revision.id}` });
    vi.unstubAllEnvs();
  });

  it.each(["topic", "reply"] as const)("rejects deletion of a %s revision through the other route kind", async kind => {
    const id = await topic();
    const reply = kind === "reply" ? await createReply(h.db, author, id, { body: "Reply history.", lang: "en" }, { now: start }) : null;
    if (reply && !reply.ok) throw new Error(reply.error);
    const target = reply?.id ?? id;
    await edit(target, "Changed source.", minute(31), kind);
    const [revision] = await revisions(target);
    const route = await import("~/routes/entry-history");
    const wrongPrefix = kind === "topic" ? "c" : "t";
    const args = h.args(h.request(`/${wrongPrefix}/${target}/history/${revision.id}`, { as: "history_author", form: { confirm: "delete" } }), { id: String(target), version: String(revision.id) });
    expect(await h.outcome(() => route.action(args))).toMatchObject({ status: 404 });
    expect((await revisions(target))[0].deletedAt).toBeNull();
  });
});

it("diffs sentences without dropping whitespace, and bounds large comparisons", () => {
  for (const [before, after] of [["One. Two.\n\nThree.", "One. New.\n\nThree."], ["", "日本語。次の文。"], ["A. ".repeat(600), "B. ".repeat(600)]]) {
    const diff = historyDiff(before, after);
    expect(diff.filter(c => c.kind !== "added").map(c => c.text).join("")).toBe(before);
    expect(diff.filter(c => c.kind !== "removed").map(c => c.text).join("")).toBe(after);
    expect(diff.some(c => c.kind !== "same")).toBe(true);
  }
});

it.skipIf(!PG_MODE).each(["reply", "vote"])("serializes a concurrent first %s with an author edit on PostgreSQL", { tags: ["postgres"] }, async reaction => {
  const id = await topic();
  let ready!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const engagement = h.db.transaction(async tx => {
    if (reaction === "vote") expect(await setVote(tx, reader, id, true, { now: minute(1) })).toMatchObject({ ok: true });
    else expect(await createReply(tx, reader, id, { body: "Concurrent response.", lang: "en" }, { now: minute(1) })).toMatchObject({ ok: true });
    ready(); await gate;
  });
  await inside;
  const edited = edit(id, "Edited after concurrent engagement.", minute(2));
  try {
    await expect.poll(async () => {
      const { sql } = await import("drizzle-orm");
      const { rows } = await h.db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as { rows: { waiting: number }[] };
      return rows[0].waiting;
    }).toBeGreaterThan(0);
  } finally { release(); }
  await engagement; await edited;
  expect(await revisions(id)).toHaveLength(1);
});

it.skipIf(!PG_MODE)("orders a signed reply edit after an already queued child reply without deadlock", { tags: ["postgres"] }, async () => {
  const id = await topic();
  const parent = await createReply(h.db, author, id, { body: "Signed parent.", lang: "en" }, { now: start });
  if (!parent.ok) throw new Error(parent.error);
  const credential = await signingCredential(h.db, author);
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, author));
  const request = await attachSigningProof(h.db, author, h.request(`/c/${parent.id}/edit`, { as: "history_author", form: { body: "Signed correction.", lang: "en" } }), credential);
  let ready!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = h.db.transaction(async tx => {
    await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, id)).for("no key update");
    ready(); await gate;
  });
  await inside;
  const waiting = async () => {
    const { sql } = await import("drizzle-orm");
    const { rows } = await h.db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as { rows: { waiting: number }[] };
    return rows[0].waiting;
  };
  const child = createReply(h.db, reader, id, { body: "Queued child.", lang: "en", parentId: parent.id });
  let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await expect.poll(waiting).toBeGreaterThanOrEqual(1);
    const route = await import("~/routes/reply-edit");
    const edited = h.outcome(() => route.action(h.args(request, { id: String(parent.id) })));
    results = Promise.allSettled([child, edited]);
    await expect.poll(waiting).toBeGreaterThanOrEqual(2);
  } finally { release(); }
  try {
    await blocker;
    expect(await results!).toMatchObject([{ status: "fulfilled", value: { ok: true } }, { status: "fulfilled", value: { status: 302 } }]);
  } finally { await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, author)); }
});
