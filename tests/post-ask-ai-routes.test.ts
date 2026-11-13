import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { aiQuestionReports, drafts, entries, llmUsage, rateLimits } from "~/lib/db/schema";
import { action, loader as resourceLoader } from "~/routes/post-ask-ai-action";
import { loader } from "~/routes/post-ask-ai";
import { loader as topicLoader } from "~/routes/topic";
import { loader as reportLoader } from "~/routes/admin-ai-question-reports";
import * as engines from "~/lib/ai-question-answer.server";
import type { AiQuestionResponse } from "~/lib/ai-questions";

let h: RouteHarness;
let id: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("zask_route_author", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("zask_route_reader", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("zask_route_operator", { homeArea: "en", readLangs: ["en"] });
  const topic = await createTopic(h.db, h.ids.zask_route_author, { title: "A question target", body: "A source sentence for the reader.", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  id = topic.id;
});
afterAll(() => h.restore());
beforeEach(async () => {
  vi.stubEnv("POST_ASK_AI", "1");
  vi.stubEnv("OPERATOR_EMAILS", "zask_route_operator@example.com");
  await h.db.delete(aiQuestionReports);
  await h.db.delete(drafts);
  await h.db.delete(llmUsage);
  await h.db.delete(rateLimits);
  await h.db.update(entries).set({ hiddenAt: null, deletedAt: null }).where(eq(entries.id, id));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function jsonRequest(payload: unknown, as = "zask_route_reader", headers: Record<string, string> = {}) {
  const original = h.request(`/t/${id}/ask/action?lang=en`, { as, headers });
  const all = new Headers(original.headers);
  all.set("content-type", "application/json");
  return new Request(original, { method: "POST", headers: all, body: JSON.stringify(payload) });
}
async function post(payload: unknown, as = "zask_route_reader") {
  return action(h.args(jsonRequest(payload, as), { id: String(id) }));
}
async function answer(question = "PRIVATE_ROUTE_QUESTION_29fdd") {
  const response = await post({ intent: "ask", question });
  expect(response.status).toBe(200);
  return { question, response: await response.json() as AiQuestionResponse };
}

it("requires member login for the page and browser POST, even when public reading is on", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  const page = await h.outcome(() => loader(h.args(h.request(`/t/${id}/ask`), { id: String(id) })));
  expect(page.status).toBe(302);
  expect(page.location).toContain("/login");
  const resource = await h.outcome(() => action(h.args(new Request(`http://localhost:5173/t/${id}/ask/action`, { method: "POST", headers: { origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ intent: "ask", question: "Anonymous question" }) }), { id: String(id) })));
  expect(resource.status).toBe(302);
  const topic = await topicLoader(h.args(h.request(`/t/${id}`), { id: String(id) }));
  expect(topic.askAi).toBeNull();
  expect(await h.db.select().from(llmUsage)).toEqual([]);
});

it("hides the entry and disables both routes when switched off", async () => {
  vi.stubEnv("POST_ASK_AI", "");
  const topic = await topicLoader(h.args(h.request(`/t/${id}`, { as: "zask_route_reader" }), { id: String(id) }));
  expect(topic.askAi).toBeNull();
  expect((await h.outcome(() => loader(h.args(h.request(`/t/${id}/ask`, { as: "zask_route_reader" }), { id: String(id) })))).status).toBe(404);
  expect((await h.outcome(() => post({ intent: "ask", question: "Disabled question" }))).status).toBe(404);
  expect(await h.db.select().from(llmUsage)).toEqual([]);
});

it("uses one small entry and reloading the page returns no previous question or answer", async () => {
  const topic = await topicLoader(h.args(h.request(`/t/${id}`, { as: "zask_route_reader" }), { id: String(id) }));
  expect(topic.askAi?.href).toBe(`/t/${id}/ask?lang=en`);
  const a = await answer();
  const own = await loader(h.args(h.request(`/t/${id}/ask`, { as: "zask_route_reader" }), { id: String(id) }));
  const other = await loader(h.args(h.request(`/t/${id}/ask`, { as: "zask_route_author" }), { id: String(id) }));
  for (const value of [own, other]) {
    expect(JSON.stringify(value)).not.toContain(a.question);
    expect(JSON.stringify(value)).not.toContain(a.response.receipt);
    expect(value).not.toHaveProperty("answer");
    expect(value).not.toHaveProperty("response");
  }
  expect((await resourceLoader()).status).toBe(405);
  expect(await h.db.select().from(drafts)).toEqual([]);
  expect(await h.db.select().from(aiQuestionReports)).toEqual([]);
});

it("rejects cross-origin posts before consuming the body or calling the provider", async () => {
  const engine = vi.spyOn(engines, "resolveQuestionCompleter");
  const outcome = await h.outcome(() => action(h.args(jsonRequest({ intent: "ask", question: "CSRF question" }, "zask_route_reader", { origin: "https://example.invalid" }), { id: String(id) })));
  expect(outcome.status).toBe(403);
  expect(engine).not.toHaveBeenCalled();
});

it("does not accept native URL-encoded submissions, malformed JSON, unknown actions or oversized questions", async () => {
  const native = h.request(`/t/${id}/ask/action`, { as: "zask_route_reader", form: { intent: "ask", question: "Native private question" } });
  expect((await action(h.args(native, { id: String(id) }))).status).toBe(400);
  expect((await post({ intent: "publish", question: "Do not publish" })).status).toBe(400);
  expect((await post({ intent: "ask", question: "x".repeat(2001) })).status).toBe(400);
  const malformed = new Request(jsonRequest({}), { body: "{ private malformed JSON" });
  expect((await action(h.args(malformed, { id: String(id) }))).status).toBe(400);
  const nul = await post({ intent: "ask", question: "private\0question" });
  expect(nul.status).toBe(400);
  const large = await post({ intent: "ask", question: "q", padding: "x".repeat(100_000) });
  expect(large.status).toBe(400);
  expect(await h.db.select().from(llmUsage)).toEqual([]);
});

it("requires explicit consent and a matching member, target, question and answer for reporting", async () => {
  const a = await answer();
  expect((await post({ intent: "report", ...a, consent: false })).status).toBe(400);
  expect((await post({ intent: "report", ...a, consent: true }, "zask_route_author")).status).toBe(403);
  expect((await post({ intent: "report", ...a, question: "Changed question", consent: true })).status).toBe(403);
  const changed = structuredClone(a);
  changed.response.answer.readings[0].text = "An answer the provider never gave.";
  expect((await post({ intent: "report", ...changed, consent: true })).status).toBe(403);
  expect(await h.db.select().from(aiQuestionReports)).toEqual([]);
  const sent = await post({ intent: "report", ...a, consent: true });
  expect(sent.headers.get("cache-control")).toBe("private, no-store");
  expect(await sent.json()).toEqual({ reported: true });
  expect(await h.db.select().from(aiQuestionReports)).toMatchObject([{ reporterId: h.ids.zask_route_reader, topicId: id, question: a.question }]);
  expect((await h.outcome(() => reportLoader(h.args(h.request("/admin/ai-question-reports", { as: "zask_route_author" }))))).status).toBe(404);
  const operator = await reportLoader(h.args(h.request("/admin/ai-question-reports", { as: "zask_route_operator" })));
  expect(operator.reports[0].question).toBe(a.question);
  expect(operator.reports[0]).not.toHaveProperty("reporterId");
});

it("creates only the member's reply draft and never publishes or copies the answer automatically", async () => {
  const a = await answer();
  const before = await h.db.select({ id: entries.id }).from(entries);
  expect((await post({ intent: "draft", ...a }, "zask_route_author")).status).toBe(403);
  const made = await post({ intent: "draft", ...a });
  expect(made.status).toBe(200);
  expect((await made.json()).draftUrl).toMatch(/^\/drafts\/[1-9]\d*$/);
  expect(await h.db.select().from(drafts)).toMatchObject([{ authorId: h.ids.zask_route_reader, kind: "reply", threadId: id, body: a.question, lang: "en" }]);
  expect(await h.db.select({ id: entries.id }).from(entries)).toEqual(before);
  expect(await h.db.select().from(aiQuestionReports)).toEqual([]);
});

it("cannot ask, report or create a draft for a hidden target", async () => {
  const a = await answer();
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
  for (const payload of [{ intent: "ask", question: a.question }, { intent: "draft", ...a }, { intent: "report", ...a, consent: true }]) {
    expect((await post(payload)).status).toBe(404);
  }
  expect(await h.db.select().from(aiQuestionReports)).toEqual([]);
  expect(await h.db.select().from(drafts)).toEqual([]);
});
