import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { PG_MODE } from "./helpers/pg-test";
import { nushiFixture } from "./helpers/nushi";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { entries, entryRevisions, jobs, nushiAnswers, nushiRequests, nushiTranslations, translations, villages } from "~/lib/db/schema";
import { canRefreshNushi, processNushiRequest, readNushiAnswer, requestNushiAgain, resolveNushiCompleter, threadNushi } from "~/lib/nushi.server";
import { nushiBody, nushiMarkdownBlocks } from "~/lib/nushi-markdown.server";
import { NushiAnswer } from "~/components/nushi";
import { createNushiTranslationHandlers } from "~/lib/nushi-translations.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const f = await nushiFixture();
  await processNushiRequest(f.db, f.request.id);
  const [answer] = await f.db.select().from(nushiAnswers);
  return { ...f, answer };
}
async function edit(f: Awaited<ReturnType<typeof fixture>>, id = f.source, coalesce = false) {
  const [entry] = await f.db.select().from(entries).where(eq(entries.id, id));
  expect(await editEntry(f.db, entry.authorId, id, { title: entry.title, body: entry.body + " Updated timing.", lang: entry.lang },
    { now: new Date(entry.createdAt.getTime() + (coalesce ? 1000 : 3_600_000)) })).toMatchObject({ ok: true, changed: true });
}
it.each(["source", "topic", "caller"])("retains the original answer with a warning after a public %s edit", async kind => {
  const f = await fixture();
  let id = f.source, answerId = f.answer.id;
  if (kind !== "source") {
    const call = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard", lang: "en" });
    if (!call.ok) throw new Error(call.error);
    const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
    await processNushiRequest(f.db, request.id);
    const [answer] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
    answerId = answer.id; id = kind === "topic" ? f.topic : call.id;
  }
  const original = await readNushiAnswer(f.db, answerId);
  await edit(f, id);
  const view = await readNushiAnswer(f.db, answerId);
  expect(view).toMatchObject({ hidden: false, sourcesChanged: true });
  if (!view || view.hidden || !original || original.hidden) throw new Error("Answer hidden");
  expect(view.answer).toEqual(original.answer);
  expect(nushiBody(view)).toContain(m.nushi_sources_edited());
  const html = renderToStaticMarkup(createElement(NushiAnswer, { answer: view }));
  expect(html).toContain(m.nushi_sources_edited());
  expect((await nushiMarkdownBlocks(f.db, f.topic, [f.topic, id], "en")).join("\n")).toContain("sources_changed: true");
});
it("ignores edits to replies that supplied neither evidence nor context", async () => {
  const f = await fixture();
  const other = await createReply(f.db, "nushi-follower", f.topic, { body: "An unrelated late reply.", lang: "en" });
  if (!other.ok) throw new Error(other.error);
  await edit(f, other.id);
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: false, sourcesChanged: false });
});
it.each(["deleted", "hidden", "private", "moved", "author", "history", "coalesced"])("withdraws content when its source becomes %s", async kind => {
  const f = await fixture();
  if (kind === "history") {
    await edit(f);
    await f.db.update(entryRevisions).set({ deletedAt: new Date() }).where(eq(entryRevisions.entryId, f.source));
  } else if (kind === "coalesced") await edit(f, f.source, true);
  else if (kind === "private") await f.db.update(villages).set({ kind: "closed" }).where(eq(villages.id, f.village.id));
  else if (kind === "moved") {
    const [village] = await f.db.insert(villages).values({ kind: "open", slug: "other-stale-village" }).returning();
    await f.db.update(entries).set({ villageId: village.id }).where(eq(entries.id, f.source));
  } else await f.db.update(entries).set(kind === "deleted" ? { deletedAt: new Date() } : kind === "hidden" ? { hiddenAt: new Date() } : { authorId: "nushi-follower" }).where(eq(entries.id, f.source));
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: true });
  expect((await f.db.select().from(nushiAnswers))[0].hiddenAt).not.toBeNull();
  expect((await nushiMarkdownBlocks(f.db, f.topic, [f.topic], "en")).join("\n")).not.toContain(f.answer.answer.citations[0].original.quote);
});
it.each(["edit", "delete"])("warns after a supplied translation %s and preserves answer translations", async kind => {
  const f = await nushiFixture();
  const [source] = await f.db.select().from(entries).where(eq(entries.id, f.source));
  await f.db.update(entries).set({ lang: "ja", title: null }).where(eq(entries.id, f.source));
  await f.db.insert(translations).values({ entryId: f.source, lang: "en", text: "A supplied orchard translation.", sourceHash: source.sourceHash, engine: "fake", model: "fake", kind: "primary", field: "body", flags: [] });
  await processNushiRequest(f.db, f.request.id);
  const [answer] = await f.db.select().from(nushiAnswers);
  expect(answer.answer.citations.some(c => c.translation)).toBe(true);
  const [job] = await f.db.select().from(jobs).where(and(eq(jobs.kind, "translate_nushi"), eq(jobs.dedupeKey, `nushi-translation:${answer.id}:ja`)));
  await createNushiTranslationHandlers().translate_nushi(job, { db: f.db, now: new Date() });
  if (kind === "edit") await f.db.update(translations).set({ text: "Corrected translation." }).where(eq(translations.entryId, f.source));
  else await f.db.delete(translations).where(eq(translations.entryId, f.source));
  const view = await readNushiAnswer(f.db, answer.id, "ja");
  expect(view).toMatchObject({ hidden: false, translated: true, sourcesChanged: true });
  expect(await f.db.select().from(nushiTranslations)).toHaveLength(1);
});
it("limits refresh to the caller and atomically replaces the answer without changing human aggregates", async () => {
  const f = await fixture(); await edit(f);
  const value = (await readNushiAnswer(f.db, f.answer.id))!;
  expect(await canRefreshNushi(f.db, value)).toBe(false);
  expect(await canRefreshNushi(f.db, value, "nushi-follower")).toBe(false);
  expect(await canRefreshNushi(f.db, value, "nushi-caller")).toBe(true);
  expect(await requestNushiAgain(f.db, "nushi-follower", f.answer.id)).toBe(false);
  const reply = await createReply(f.db, "nushi-follower", f.topic, { body: "A human reply to the previous answer.", lang: "en", nushiParentId: f.answer.id });
  expect(reply.ok).toBe(true);
  const [before] = await f.db.select().from(entries).where(eq(entries.id, f.topic));
  expect(await requestNushiAgain(f.db, "nushi-caller", f.answer.id)).toBe(true);
  expect(await requestNushiAgain(f.db, "nushi-caller", f.answer.id)).toBe(true);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.replacesAnswerId, f.answer.id));
  expect((await threadNushi(f.db, f.topic, [f.topic], "en")).requests).toMatchObject([{ state: "pending" }]);
  await processNushiRequest(f.db, request.id);
  const [answer] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  expect(answer).toBeDefined();
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: true, reason: "superseded", supersededById: answer.id });
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: false, sourcesChanged: false });
  expect(await f.db.select().from(nushiAnswers).where(isNull(nushiAnswers.hiddenAt))).toHaveLength(1);
  expect(await f.db.select().from(nushiRequests)).toHaveLength(2);
  const [after] = await f.db.select().from(entries).where(eq(entries.id, f.topic));
  expect(after.replyCount).toBe(before.replyCount); expect(after.lastActivityAt).toEqual(before.lastActivityAt);
  if (reply.ok) expect((await f.db.select().from(entries).where(eq(entries.id, reply.id)))[0].nushiParentId).toBe(f.answer.id);
  const marker = (await readNushiAnswer(f.db, f.answer.id))!;
  expect(renderToStaticMarkup(createElement(NushiAnswer, { answer: marker }))).toContain(`/nushi/${answer.id}`);
  expect(nushiBody(marker)).toContain(`/nushi/${answer.id}`);
  expect((await nushiMarkdownBlocks(f.db, f.topic, [f.topic], "en")).join("\n")).toContain(`superseded_by: "/nushi/${answer.id}"`);
});
it("allows a source-withdrawn answer to be refreshed while its public call survives", async () => {
  const f = await fixture();
  await f.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, f.source));
  expect(await canRefreshNushi(f.db, (await readNushiAnswer(f.db, f.answer.id))!, "nushi-caller")).toBe(true);
  expect(await requestNushiAgain(f.db, "nushi-caller", f.answer.id)).toBe(true);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.replacesAnswerId, f.answer.id));
  await processNushiRequest(f.db, request.id);
  expect(await f.db.select().from(nushiAnswers).where(isNull(nushiAnswers.hiddenAt))).toHaveLength(1);
});
it.each(["deleted", "hidden", "disabled"])("refuses refresh after the calling topic is %s", async kind => {
  const f = await fixture(); await edit(f);
  await f.db.update(entries).set(kind === "deleted" ? { deletedAt: new Date() } : kind === "hidden" ? { hiddenAt: new Date() } : { nushiDisabled: true }).where(eq(entries.id, f.topic));
  expect(await canRefreshNushi(f.db, (await readNushiAnswer(f.db, f.answer.id))!, "nushi-caller")).toBe(false);
  expect(await requestNushiAgain(f.db, "nushi-caller", f.answer.id)).toBe(false);
});
it.each(["limit", "budget"])("retains the stale answer when refreshing reaches the %s", async failure => {
  const f = await fixture(); await edit(f);
  expect(await requestNushiAgain(f.db, "nushi-caller", f.answer.id)).toBe(true);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.replacesAnswerId, f.answer.id));
  const fake = resolveNushiCompleter(), complete = vi.fn(fake.complete);
  const env = { ...process.env, ...(failure === "limit" ? { VILLAGE_NUSHI_MEMBER_DAILY_LIMIT: "1" } : { VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD: "0" }) };
  await processNushiRequest(f.db, request.id, { env, completer: { ...fake, complete } });
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, request.id)))[0]).toMatchObject({ state: "failed", failure });
  expect(complete).not.toHaveBeenCalled();
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: false, sourcesChanged: true });
});
it("keeps warnings local and propagates withdrawal through AI follow-ups", async () => {
  const f = await fixture();
  vi.stubEnv("VILLAGE_NUSHI_AUTHOR_DAILY_LIMIT", "1");
  const call = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi another detail", lang: "en", nushiParentId: f.answer.id });
  if (!call.ok) throw new Error(call.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
  await processNushiRequest(f.db, request.id);
  const [child] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  expect(child).toBeDefined();
  await edit(f);
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: false, sourcesChanged: true });
  expect(await readNushiAnswer(f.db, child.id)).toMatchObject({ hidden: false, sourcesChanged: false });
  await f.db.update(nushiAnswers).set({ hiddenAt: new Date(), hiddenReason: "moderation" }).where(eq(nushiAnswers.id, f.answer.id));
  expect(await readNushiAnswer(f.db, child.id)).toMatchObject({ hidden: true });
});

const pg = it.skipIf(!PG_MODE);
pg("serializes double refresh submissions across PostgreSQL connections", async () => {
  const f = await fixture(); await edit(f);
  expect(await Promise.all([requestNushiAgain(f.db, "nushi-caller", f.answer.id), requestNushiAgain(f.db, "nushi-caller", f.answer.id)])).toEqual([true, true]);
  const requests = await f.db.select().from(nushiRequests).where(eq(nushiRequests.replacesAnswerId, f.answer.id));
  expect(requests).toHaveLength(1);
  await processNushiRequest(f.db, requests[0].id);
  expect(await f.db.select().from(nushiAnswers).where(isNull(nushiAnswers.hiddenAt))).toHaveLength(1);
  expect(await requestNushiAgain(f.db, "nushi-caller", f.answer.id)).toBe(false);
});
pg.each(["edit", "delete", "call-delete"])("does not replace the answer across a concurrent %s", async kind => {
  const f = await fixture(); await edit(f);
  await requestNushiAgain(f.db, "nushi-caller", f.answer.id);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.replacesAnswerId, f.answer.id));
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const releasing = new Promise<void>(resolve => { release = resolve; });
  const fake = resolveNushiCompleter();
  const processing = processNushiRequest(f.db, request.id, { completer: { ...fake, async complete(req) { entered(); await releasing; return fake.complete(req); } } });
  await entering;
  try {
    if (kind === "edit") await edit(f);
    else await f.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, kind === "call-delete" ? f.topic : f.source));
  } finally { release(); }
  await processing;
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  expect((await f.db.select().from(nushiAnswers))[0].supersededById).toBeNull();
  expect(await f.db.select().from(nushiAnswers).where(isNull(nushiAnswers.hiddenAt))).toHaveLength(kind === "edit" ? 1 : 0);
});

it("marks stale answers in MCP and excludes their content after history deletion", async () => {
  const { handlePublicMcpRequest } = await import("~/lib/mcp/server.server");
  const f = await fixture(); await edit(f);
  const baseURL = "https://forum.example.org";
  const read = async () => {
    const response = await handlePublicMcpRequest(new Request(`${baseURL}/mcp/public`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_thread", arguments: { id: f.topic, lang: "en" } } }),
    }), { db: f.db, baseURL });
    expect(response.status).toBe(200);
    const text = await response.text();
    return JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? /^data: (.+)$/m.exec(text)![1] : text);
  };
  const stale = JSON.stringify(await read());
  expect(stale).toContain("sources_changed: true");
  expect(stale).toContain(m.nushi_sources_edited());
  const quote = f.answer.answer.citations[0].original.quote;
  expect(stale).toContain(quote);
  await f.db.update(entryRevisions).set({ deletedAt: new Date() }).where(eq(entryRevisions.entryId, f.source));
  const hidden = JSON.stringify(await read());
  expect(hidden).not.toContain(quote);
  expect(hidden).toContain("hidden: true");
});

it("keeps identical current text readable after language metadata changes and history deletion", async () => {
  const f = await fixture();
  const [source] = await f.db.select().from(entries).where(eq(entries.id, f.source));
  await f.db.update(entries).set({ lang: "de" }).where(eq(entries.id, f.source));
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: false, sourcesChanged: true });
  await edit(f);
  expect(await editEntry(f.db, "nushi-owner", f.source, { title: source.title, body: source.body, lang: source.lang }, { now: new Date(source.createdAt.getTime() + 7_200_000) })).toMatchObject({ ok: true });
  await f.db.update(entryRevisions).set({ deletedAt: new Date() }).where(eq(entryRevisions.entryId, f.source));
  expect(await readNushiAnswer(f.db, f.answer.id)).toMatchObject({ hidden: false, sourcesChanged: true });
});

it("reconstructs the original material for a consented report on a stale answer", async () => {
  const { reportNushi } = await import("~/lib/nushi-reports.server");
  const { nushiReports } = await import("~/lib/db/schema");
  const f = await fixture();
  await edit(f); await edit(f, f.topic);
  expect(await reportNushi(f.db, "nushi-follower", { answerId: f.answer.id, kind: "error", reason: "wrong_post", note: "Review the original evidence.", consent: true })).toBe(true);
  const [report] = await f.db.select().from(nushiReports);
  expect(JSON.stringify(report.evidence)).not.toContain("Updated timing.");
  expect(JSON.stringify(report.evidence)).toContain(f.answer.answer.citations[0].original.quote);
});
