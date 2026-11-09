import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { action, loader } from "~/routes/ai-draft";
import { createDraft, getDraft, updateDraft } from "~/lib/drafts.server";
import { createTopic, createReply } from "~/lib/entries.server";
import { drafts, entries, jobs, profiles, memberSignatures } from "~/lib/db/schema";
import { DRAFT_RATE_LIMIT, hitRateLimit, hitMemberLimit, MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { attachSigningProof, signingCredential } from "./helpers/signing";
import { createApiToken } from "~/lib/tokens.server";
import { createElement } from "react";
import { renderInRouter } from "./helpers/render-in-router";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); for (const handle of ["drafter", "other", "limited", "stopped", "signed"]) await h.signIn(handle); });
afterAll(() => h.restore());
const request = (form: Record<string, string>, as = "drafter", headers?: Record<string, string>) => h.request("/drafts/ai-write", { as, form: { ownerId: h.ids[as], body: "https://example.org/a\n\n本人のコメント", lang: "ja", ...form }, headers });
async function save(form: Record<string, string> = {}, as = "drafter", headers?: Record<string, string>) { return action(h.args(request(form, as, headers))); }

it("saves a private titleless draft and frontmatter through the existing parser without creating posts or translation jobs", async () => {
  const before = await h.db.select().from(entries);
  const jobsBefore = await h.db.select().from(jobs);
  const response = await save();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const result = await response.json();
  expect(result).toMatchObject({ version: 1, lang: "ja", body: "https://example.org/a\n\n本人のコメント" });
  expect(await getDraft(h.db, h.ids.drafter, result.id)).toMatchObject({ via: "web", title: null, version: 1 });
  expect(await h.db.select().from(entries)).toEqual(before);
  expect(await h.db.select().from(jobs)).toEqual(jobsBefore);
  const rate = await hitMemberLimit(h.db, "topic", h.ids.drafter);
  expect(rate.remaining).toBe(MEMBER_RATE_LIMITS.topic.limit - 1);
  const parsed = await (await save({ body: "---\ntitle: Test title\nlang: en\n---\nMy note", lang: "" })).json();
  expect(await getDraft(h.db, h.ids.drafter, parsed.id)).toMatchObject({ title: "Test title", body: "My note", lang: "en" });
});

it("updates the same browser topic, rejects stale edits and preserves fixed alternative targets and literal pasted frontmatter", async () => {
  const topic = await createTopic(h.db, h.ids.drafter, { asksStance: true, title: "Question", body: "Question body", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const first = await (await save({ asksStance: "1", altOf: String(topic.id) })).json();
  const body = "---\nlang: fr\ntitle: Candidate\n---\nAI candidate";
  const second = await (await save({ draftId: String(first.id), version: "1", body, title: "My title", lang: "en", asksStance: "1", altOf: "99999" })).json();
  expect(second).toMatchObject({ id: first.id, version: 2, lang: "en", body });
  expect(await getDraft(h.db, h.ids.drafter, first.id)).toMatchObject({ altOf: topic.id, title: "My title", body, version: 2 });
  const stale = await save({ draftId: String(first.id), version: "1", body: "Old text", asksStance: "1" });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "draft_conflict" });
  expect((await getDraft(h.db, h.ids.drafter, first.id))?.body).toBe(body);
});

it("enforces browser session, same-origin, account identity, writer and draft-kind boundaries", async () => {
  expect((await loader()).status).toBe(405);
  expect(await h.outcome(() => action(h.args(request({}, "drafter", { origin: "https://outside.example" }))))).toMatchObject({ status: 403 });
  const bearer = await action(h.args(h.request("/drafts/ai-write", { form: { body: "No cookie" }, headers: { authorization: "Bearer invalid" } })));
  expect(bearer.status).toBe(401);
  for (const kind of ["read", "draft"] as const) {
    const token = await createApiToken(h.db, h.ids.drafter, { name: "Test client", kind });
    if (!token.ok) throw new Error(token.error);
    const response = await action(h.args(h.request("/drafts/ai-write", { form: { ownerId: h.ids.drafter, body: "Bearer cannot save", lang: "ja" }, headers: { authorization: `Bearer ${token.token}` } })));
    expect(response.status).toBe(401);
  }
  expect((await save({ ownerId: h.ids.other })).status).toBe(409);
  const created = await (await save()).json();
  expect((await save({ draftId: String(created.id), version: "1" }, "other")).status).toBe(404);
  const api = await createDraft(h.db, h.ids.drafter, { kind: "topic", body: "API", lang: "ja" }, { via: "api" });
  const t = await createTopic(h.db, h.ids.drafter, { body: "Topic", lang: "ja" });
  if (!api.ok || !t.ok) throw new Error("fixture failed");
  const reply = await createDraft(h.db, h.ids.drafter, { kind: "reply", threadId: t.id, body: "Reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  for (const id of [api.id, reply.id]) expect((await save({ draftId: String(id), version: "1" })).status).toBe(404);
  expect((await save({ intro: "1" })).status).toBe(400);
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60000) }).where(eq(profiles.userId, h.ids.stopped));
  expect((await save({}, "stopped")).status).toBe(403);
});

it("reuses the draft allowance and rejects invalid language or oversized bodies", async () => {
  for (let i = 0; i < DRAFT_RATE_LIMIT.limit; i++) await hitRateLimit(h.db, { key: `draft:member:${h.ids.limited}`, ...DRAFT_RATE_LIMIT });
  const rate = await save({}, "limited");
  expect(rate.status).toBe(429);
  expect(rate.headers.has("retry-after")).toBe(true);
  expect((await save({ lang: "invalid" })).status).toBe(400);
  expect((await save({ body: "x".repeat(50001) })).status).toBe(400);
});

it("saves and updates a reply draft with its fixed thread, parent and stance tag", async () => {
  const topic = await createTopic(h.db, h.ids.drafter, { title: "A question", body: "A question body", lang: "en", asksStance: true });
  if (!topic.ok) throw new Error(topic.error);
  const parent = await createReply(h.db, h.ids.other, topic.id, { body: "A parent reply", lang: "en" });
  if (!parent.ok) throw new Error(parent.error);
  const before = await h.db.select().from(entries);
  const fields = { kind: "reply", threadId: String(topic.id), parentId: String(parent.id), stanceTag: "agree", body: "A reason", lang: "en" };
  const response = await save(fields);
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(await getDraft(h.db, h.ids.drafter, first.id)).toMatchObject({ kind: "reply", threadId: topic.id, parentId: parent.id, stanceTag: "agree", body: "A reason" });
  const updated = await save({ ...fields, draftId: String(first.id), version: "1", body: "An expanded reason" });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ id: first.id, version: 2 });
  expect((await save({ ...fields, draftId: String(first.id), version: "1" })).status).toBe(409);
  expect((await save({ ...fields, draftId: String(first.id), version: "2", threadId: "999999" })).status).toBe(404);
  expect((await save({ ...fields, parentId: "999999" })).status).toBe(400);
  expect(await h.db.select().from(entries)).toEqual(before);
});

it("rejects changing an existing AI reply draft's parent", async () => {
  const topic = await createTopic(h.db, h.ids.drafter, { body: "A reply destination", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const parent = await createReply(h.db, h.ids.other, topic.id, { body: "A parent", lang: "en" });
  if (!parent.ok) throw new Error(parent.error);
  const fields = { kind: "reply", threadId: String(topic.id), parentId: String(parent.id), body: "Original reply", lang: "en" };
  const first = await (await save(fields)).json();
  const changed = await save({ ...fields, draftId: String(first.id), version: "1", parentId: "", body: "For another target" });
  expect(changed.status).toBe(409);
  expect(await getDraft(h.db, h.ids.drafter, first.id)).toMatchObject({ parentId: parent.id, body: "Original reply", version: 1 });
});

it("preserves a reply draft's tag when its hidden parent no longer offers a selector", async () => {
  const topic = await createTopic(h.db, h.ids.drafter, { title: "A hidden question", body: "A question", lang: "en", asksStance: true });
  if (!topic.ok) throw new Error(topic.error);
  const draft = await createDraft(h.db, h.ids.drafter, { kind: "reply", threadId: topic.id, body: "A reason", lang: "en", stanceTag: "agree" });
  if (!draft.ok) throw new Error(draft.error);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
  const saved = await save({ kind: "reply", threadId: String(topic.id), draftId: String(draft.id), version: "1", body: "A revised reason", lang: "en" });
  expect(saved.status).toBe(200);
  expect(await getDraft(h.db, h.ids.drafter, draft.id)).toMatchObject({ stanceTag: "agree", body: "A revised reason" });
});

it("normal saves establish a new basis while stale or missing versions cannot save or publish", async () => {
  const { action: edit } = await import("~/routes/draft");
  const first = await (await save()).json();
  const path = `/drafts/${first.id}`;
  const send = (form: Record<string, string>) => h.outcome(() => edit(h.args(h.request(path, { as: "drafter", form: { body: "Edited", lang: "ja", ...form } }), { id: String(first.id) })));
  expect(await send({ intent: "save", version: "1" })).toMatchObject({ status: 200, value: { data: { saved: true, version: 2 } } });
  for (const intent of ["save", "publish"]) {
    expect(await send({ intent, version: "1" })).toMatchObject({ status: 409, value: { data: { saved: false, latest: { draft: { body: "Edited", version: 2 } } } } });
    expect(await send({ intent })).toMatchObject({ status: 409 });
  }
  expect((await getDraft(h.db, h.ids.drafter, first.id))?.version).toBe(2);
  expect(await send({ intent: "publish", version: "2", body: "Source\n\nComment\n\nAI text" })).toMatchObject({ status: 302 });
  expect(await getDraft(h.db, h.ids.drafter, first.id)).toBeNull();
  expect(await send({ intent: "save", version: "2" })).toMatchObject({ status: 404, value: { data: { saved: false } } });
});

it("renders submitted title, body, language and the old version after a native save or publish conflict", async () => {
  const { action: edit, loader: load, default: DraftPage } = await import("~/routes/draft");
  const first = await (await save({ title: "Initial title" })).json();
  const path = `/drafts/${first.id}`;
  await updateDraft(h.db, h.ids.drafter, first.id, { title: "Latest title", body: "Latest stored body", lang: "ja" }, { expectedVersion: 1 });
  for (const intent of ["save", "publish"]) {
    const fields = { intent, title: "Unsaved title", body: "Unsaved <note>", lang: "en", asksStance: "1", version: "1", signingView: first.signingView };
    const result = await edit(h.args(h.request(path, { as: "drafter", form: fields }), { id: String(first.id) }));
    expect(result).toMatchObject({ init: { status: 409 }, data: { saved: false, values: { title: fields.title, body: fields.body, lang: "en", asksStance: true, version: "1" }, latest: { draft: { version: 2, body: "Latest stored body" } } } });
    const loaderData = await load(h.args(h.request(path, { as: "drafter" }), { id: String(first.id) }));
    const html = await renderInRouter(() => createElement(DraftPage, { loaderData, actionData: result.data, params: { id: String(first.id) }, matches: [] } as never), path);
    expect(html).toContain('value="Unsaved title"');
    expect(html).toContain('>Unsaved &lt;note&gt;</textarea>');
    expect(html).toMatch(/name="lang"[^>]*value="en"/);
    expect(html).toMatch(/name="version"[^>]*value="1"/);
    expect(html).toMatch(/name="asksStance"[^>]*checked/);
  }
  expect(await getDraft(h.db, h.ids.drafter, first.id)).toMatchObject({ version: 2, body: "Latest stored body" });
});

it("publishes imported text through the existing signed boundary and refuses stale approval", async () => {
  const { action: edit } = await import("~/routes/draft");
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.signed));
  const credential = await signingCredential(h.db, h.ids.signed);
  const first = await (await save({}, "signed")).json();
  const path = `/drafts/${first.id}`;
  const fields = { intent: "publish", version: "1", body: "https://example.org/a\n\nMy comment\n\nAI text", lang: "ja", signingView: first.signingView };
  const unsigned = h.request(path, { as: "signed", form: fields });
  expect(await h.outcome(() => edit(h.args(unsigned.clone(), { id: String(first.id) })))).toMatchObject({ status: 403 });
  const proof = await attachSigningProof(h.db, h.ids.signed, unsigned, credential);
  await updateDraft(h.db, h.ids.signed, first.id, { body: "Other editor", lang: "ja" }, { expectedVersion: 1 });
  expect(await h.outcome(() => edit(h.args(proof, { id: String(first.id) })))).toMatchObject({ status: 409 });
  const current = h.request(path, { as: "signed", form: { ...fields, version: "2" } });
  const signed = await attachSigningProof(h.db, h.ids.signed, current, credential);
  expect(await h.outcome(() => edit(h.args(signed, { id: String(first.id) })))).toMatchObject({ status: 302 });
  expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.userId, h.ids.signed))).toHaveLength(1);
  expect((await h.db.select().from(entries).where(eq(entries.authorId, h.ids.signed)))[0]).toMatchObject({ body: fields.body, lang: "ja", via: "web", aiAssistance: null });
});
