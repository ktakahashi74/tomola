import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { NushiAnswer } from "~/components/nushi";
import { entries, nushiAnswers, nushiRequests, villageMembers, villages } from "~/lib/db/schema";
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
  expect(result.materials.sources.slice(0, 3).map(s => s.id)).toEqual([`e-${f.topic}-title`, `e-${f.topic}-body`, `e-${f.parent}-body`]);
  expect(new Set(result.materials.sources.map(s => s.id)).size).toBe(result.materials.sources.length);
  expect(result.materials.sources.some(s => s.id.startsWith(`e-${f.call}-`))).toBe(false);
  const readings = result.materials.sources.slice(1, 3).map(s => ({ text: "A supplied passage supports this reading.", citations: [{ sourceId: s.id, quote: s.original }] }));
  expect(verifyQuestionAnswer(JSON.stringify({ status: "answered", readings }), result.materials)?.citations.map(c => c.sourceId)).toEqual([`e-${f.topic}-body`, `e-${f.parent}-body`]);
  // Search also finds these posts, without duplicating the priority candidates.
  const repeated = await collectNushiMaterials(f.db, { villageId: f.village.id, callerId: "nushi-caller", callingPost: "discussion", language: "en", priorityEntryIds: [f.topic, f.topic, f.parent] }, retrieval());
  expect(repeated.materials.sources.filter(s => s.id === `e-${f.topic}-body`)).toHaveLength(1);
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

it.each([undefined, false, true])("saves the checked person flag %s and displays only the corresponding guidance", async askPerson => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete() {
    return { text: JSON.stringify({ status: "not_confirmed", readings: [], askPerson }), inputTokens: 1, outputTokens: 1 };
  } } });
  const [answer] = await f.db.select().from(nushiAnswers);
  expect(answer.answer.askPerson).toBe(askPerson === true);
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
