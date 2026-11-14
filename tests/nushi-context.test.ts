import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { NushiAnswer } from "~/components/nushi";
import { entries, nushiAnswers, nushiRequests, translations, villageMembers, villages } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { collectNushiMaterials, nushiMaterials } from "~/lib/nushi-materials.server";
import { verifyQuestionAnswer } from "~/lib/ai-question-answer.server";
import { AI_QUESTION_LIMITS } from "~/lib/ai-questions";
import { processNushiRequest, readNushiAnswer, resolveNushiCompleter } from "~/lib/nushi.server";
import { nushiBody } from "~/lib/nushi-markdown.server";
import { m } from "~/paraglide/messages.js";
import { nushiFixture } from "./helpers/nushi";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const retrieval = () => ({ env: process.env, now: new Date(), clock: () => new Date() });

async function contextFixture(body = "A local discussion without the search keyword.") {
  const f = await nushiFixture();
  const topic = await createTopic(f.db, "nushi-owner", { title: "Local discussion", body, lang: "en", village: f.village.slug });
  if (!topic.ok) throw new Error(topic.error);
  const parent = await createReply(f.db, "nushi-follower", topic.id, { body: "A qualification from the reply author.", lang: "en" });
  if (!parent.ok) throw new Error(parent.error);
  const call = await createReply(f.db, "nushi-caller", topic.id, { body: "@nushi summarize", lang: "en", parentId: parent.id });
  if (!call.ok) throw new Error(call.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
  return { ...f, topic: topic.id, parent: parent.id, call: call.id, request };
}

it("prioritizes the calling topic and parent once and verifies their quotations", async () => {
  const f = await contextFixture();
  const result = (await nushiMaterials(f.db, f.request, retrieval()))!;
  expect(result.materials.sources.slice(0, 3).map(s => s.id)).toEqual([`e-${f.parent}-body`, `e-${f.topic}-title`, `e-${f.topic}-body`]);
  expect(new Set(result.materials.sources.map(s => s.id)).size).toBe(result.materials.sources.length);
  expect(result.materials.sources.some(s => s.id.startsWith(`e-${f.call}-`))).toBe(false);
  const readings = result.materials.sources.filter(s => s.field === "body").map(s => ({ text: "A supplied passage supports this reading.", citations: [{ sourceId: s.id, quote: s.original }] }));
  expect(verifyQuestionAnswer(JSON.stringify({ status: "answered", readings }), result.materials)?.citations.map(c => c.sourceId)).toEqual([`e-${f.parent}-body`, `e-${f.topic}-body`]);
  // Search also finds these posts, without duplicating the priority candidates.
  const repeated = await collectNushiMaterials(f.db, { villageId: f.village.id, callerId: "nushi-caller", callingPost: "discussion", language: "en", priorityEntryIds: [f.topic, f.topic, f.parent] }, retrieval());
  expect(repeated.materials.sources.filter(s => s.id === `e-${f.topic}-body`)).toHaveLength(1);
});

it("supplies public thread replies for a summary without matching search terms", async () => {
  const f = await contextFixture();
  const ids: number[] = [];
  for (const body of ["An objection to the proposal.", "A minority view with a condition.", "Hidden reply.", "Deleted reply."]) {
    const reply = await createReply(f.db, "nushi-owner", f.topic, { body, lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    ids.push(reply.id);
  }
  await f.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ids[2]));
  await f.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, ids[3]));
  await processNushiRequest(f.db, f.request.id);
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  const result = (await nushiMaterials(f.db, f.request, retrieval()))!;
  expect(result.materials.sources.map(s => s.id)).toEqual([`e-${f.parent}-body`, `e-${f.topic}-title`, `e-${f.topic}-body`, ...ids.slice(0, 2).map(id => `e-${id}-body`)]);
  expect(result.materials.scope).toMatchObject({ replies: 3, truncated: false });
});

it.each([false, true])("reserves half the material budget for village search with translations=%s", async translated => {
  const f = await contextFixture("A long local discussion. ".repeat(400));
  const replyIds: number[] = [];
  for (let i = 0; i < 23; i++) {
    const reply = await createReply(f.db, "nushi-owner", f.topic, { body: `Reply ${i}: a condition on the proposal. `.repeat(40), lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    replyIds.push(reply.id);
  }
  if (translated) {
    const [topic] = await f.db.select().from(entries).where(eq(entries.id, f.topic));
    await f.db.insert(translations).values({ entryId: f.topic, field: "body", lang: "ja", kind: "primary", text: "長い話題の本文です。".repeat(1000), sourceHash: topic.sourceHash });
  }
  const result = await collectNushiMaterials(f.db, { villageId: f.village.id, callerId: "nushi-caller", callingPost: "orchard", language: translated ? "ja" : "en", excludeEntryId: f.call, priorityEntryIds: [f.parent, f.topic], contextThreadId: f.topic }, retrieval());
  const localIds = new Set([f.parent, f.topic, ...replyIds]);
  const local = result.materials.sources.filter(s => localIds.has(Number(/^e-(\d+)-/.exec(s.id)![1])));
  const search = result.materials.sources.filter(s => !local.includes(s));
  const chars = (sources: typeof local) => sources.reduce((sum, s) => sum + s.original.length + (s.translation?.text.length ?? 0), 0);
  expect(chars(local)).toBe(AI_QUESTION_LIMITS.materialChars / 2);
  expect(chars(local) + chars(search)).toBeLessThanOrEqual(AI_QUESTION_LIMITS.materialChars);
  expect(search.map(s => s.id)).toEqual(expect.arrayContaining([`e-${f.source}-title`, `e-${f.source}-body`]));
  expect(result.materials.sources.slice(local.length)).toEqual(search);
  expect(replyIds.some(id => !local.some(s => s.id === `e-${id}-body`))).toBe(true);
  expect(result.materials.scope.truncated).toBe(true);
  if (translated) expect(local.some(s => s.translation?.text)).toBe(true);
});

it("rechecks newly included thread replies before publication", async () => {
  const f = await contextFixture(), fake = resolveNushiCompleter();
  const reply = await createReply(f.db, "nushi-owner", f.topic, { body: "A separate objection.", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete(req) {
    expect(JSON.parse(req.user).materials.some((s: { id: string }) => s.id === `e-${reply.id}-body`)).toBe(true);
    await f.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply.id));
    return fake.complete(req);
  } } });
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(0);
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, f.request.id)))[0]).toMatchObject({ state: "cancelled", failure: "changed" });
});

it("does not reintroduce thread replies beyond the candidate limit through search", async () => {
  const f = await contextFixture();
  const ids: number[] = [];
  for (let i = 0; i < AI_QUESTION_LIMITS.replies + 2; i++) {
    const reply = await createReply(f.db, "nushi-owner", f.topic, { body: `Boundary objection ${i}.`, lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    ids.push(reply.id);
  }
  const result = await collectNushiMaterials(f.db, { villageId: f.village.id, callerId: "nushi-caller", callingPost: "boundary orchard", language: "en", excludeEntryId: f.call, priorityEntryIds: [f.parent, f.topic], contextThreadId: f.topic }, retrieval());
  const supplied = result.materials.sources.map(s => s.id);
  expect(ids.slice(0, AI_QUESTION_LIMITS.replies).every(id => supplied.includes(`e-${id}-body`))).toBe(true);
  expect(ids.slice(AI_QUESTION_LIMITS.replies).every(id => !supplied.includes(`e-${id}-body`))).toBe(true);
  expect(supplied).toContain(`e-${f.source}-body`);
  expect(result.materials.scope).toMatchObject({ replies: AI_QUESTION_LIMITS.replies + 1, truncated: true });
});

it("bounds the full calling topic and reports clipping", async () => {
  const f = await contextFixture("A long local discussion. ".repeat(500));
  const result = (await nushiMaterials(f.db, f.request, retrieval()))!;
  const body = result.materials.sources.find(s => s.id === `e-${f.topic}-body`)!;
  expect(body.original.length).toBe(AI_QUESTION_LIMITS.sourceChars);
  expect(body.original.length).toBeGreaterThan(2000);
  expect(result.materials.scope.truncated).toBe(true);
});

it.each(["hidden", "deleted", "foreign", "closed"])("rejects %s priority candidates at the public evidence gate", async mode => {
  const f = await contextFixture();
  if (mode === "hidden" || mode === "deleted") await f.db.update(entries).set(mode === "hidden" ? { hiddenAt: new Date() } : { deletedAt: new Date() }).where(eq(entries.id, f.topic));
  else {
    const [other] = await f.db.insert(villages).values({ kind: mode === "closed" ? "closed" : "open", slug: `context-${mode}` }).returning();
    await f.db.insert(villageMembers).values({ villageId: other.id, userId: "nushi-owner", role: "owner" });
    await f.db.update(entries).set({ villageId: other.id }).where(eq(entries.id, f.topic));
  }
  const result = await collectNushiMaterials(f.db, { villageId: f.village.id, callerId: "nushi-caller", callingPost: "", language: "en", excludeEntryId: f.call, priorityEntryIds: [f.topic, f.parent, f.call] }, retrieval());
  expect(result.materials.sources).toEqual([]);
});

it.each(["hidden", "deleted"])("rejects a %s reply target while retaining its visible topic", async mode => {
  const f = await contextFixture();
  await f.db.update(entries).set(mode === "hidden" ? { hiddenAt: new Date() } : { deletedAt: new Date() }).where(eq(entries.id, f.parent));
  const result = await collectNushiMaterials(f.db, { villageId: f.village.id, callerId: "nushi-caller", callingPost: "", language: "en", priorityEntryIds: [f.topic, f.parent] }, retrieval());
  expect(result.materials.sources.map(s => s.id)).toEqual([`e-${f.topic}-title`, `e-${f.topic}-body`]);
});

it.each(["topic", "parent"])("rechecks the calling %s before publication and withdraws it after an edit", async target => {
  const f = await contextFixture(), fake = resolveNushiCompleter();
  const id = target === "topic" ? f.topic : f.parent;
  await processNushiRequest(f.db, f.request.id);
  const [answer] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, f.request.id));
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: false });
  const call = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi summarize", lang: "en", parentId: f.parent, nushiParentId: answer.id });
  if (!call.ok) throw new Error(call.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
  await processNushiRequest(f.db, request.id, { completer: { ...fake, async complete(req) {
    const data = JSON.parse(req.user);
    expect(data.context.previousAiReply).toBeTruthy();
    expect(data.materials.every((s: { id: string }) => /^e-\d+-(title|body)$/.test(s.id))).toBe(true);
    expect(data.materials.some((s: { id: string }) => s.id.startsWith(`e-${call.id}-`))).toBe(false);
    const result = await fake.complete(req);
    await f.db.update(entries).set({ body: "Revised context." }).where(eq(entries.id, id));
    return result;
  } } });
  expect(await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id))).toHaveLength(0);
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: true });
});

it.each([false, true].flatMap(omitReadings => [undefined, false, true].map(askPerson => ({ omitReadings, askPerson }))))("saves the checked person flag $askPerson with omitted readings=$omitReadings and displays only the corresponding guidance", async ({ omitReadings, askPerson }) => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete() {
    return { text: JSON.stringify({ status: "not_confirmed", ...(omitReadings ? {} : { readings: [] }), askPerson }), inputTokens: 1, outputTokens: 1 };
  } } });
  const [answer] = await f.db.select().from(nushiAnswers);
  expect(answer.answer.askPerson).toBe(askPerson === true);
  expect(answer.answer).toMatchObject({ status: "not_confirmed", readings: [], citations: [] });
  expect((await f.db.select().from(nushiRequests))[0]).toMatchObject({ state: "answered", failure: null });
  const view = (await readNushiAnswer(f.db, answer.id))!;
  const html = renderToStaticMarkup(createElement(NushiAnswer, { answer: view }));
  expect(html).toContain(m.nushi_not_found());
  expect(html.includes(m.nushi_ask_person())).toBe(askPerson === true);
  const { askPerson: _flag, ...legacy } = answer.answer;
  await f.db.update(nushiAnswers).set({ answer: legacy }).where(eq(nushiAnswers.id, answer.id));
  const legacyView = (await readNushiAnswer(f.db, answer.id))!;
  expect(renderToStaticMarkup(createElement(NushiAnswer, { answer: legacyView }))).toContain(m.nushi_ask_person());
  if (askPerson) expect(nushiBody(view)).toBe(nushiBody(legacyView));
  else expect(nushiBody(view).length).toBeLessThan(nushiBody(legacyView).length);
});

it.each([
  { status: "answered" },
  { status: "not_confirmed", readings: null },
  { status: "not_confirmed", readings: [{ text: "A reading.", citations: [{ sourceId: "e-1-body", quote: "A passage." }] }] },
  { status: "not_confirmed", askPerson: "true" },
  { status: "not_confirmed", clarificationNeeded: true },
])("rejects malformed public answers: %j", async response => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete() {
    return { text: JSON.stringify(response), inputTokens: 1, outputTokens: 1 };
  } } });
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(0);
  expect((await f.db.select().from(nushiRequests))[0]).toMatchObject({ state: "failed", failure: "unverified" });
});

it.each(["true", null, 1, [], {}].map(askPerson => ({ askPerson })))("rejects a nonboolean person flag $askPerson", async ({ askPerson }) => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete() {
    return { text: JSON.stringify({ status: "not_confirmed", readings: [], askPerson }), inputTokens: 1, outputTokens: 1 };
  } } });
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(0);
  expect((await f.db.select().from(nushiRequests))[0]).toMatchObject({ state: "failed", failure: "unverified" });
});

it("ignores a person flag on a sourced answer", async () => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete(req) {
    const result = await fake.complete(req);
    return { ...result, text: JSON.stringify({ ...JSON.parse(result.text), askPerson: true }) };
  } } });
  expect((await f.db.select().from(nushiAnswers))[0].answer).not.toHaveProperty("askPerson");
});
