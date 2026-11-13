import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { action, loader } from "~/routes/draft-autosave";
import { createDraft, deleteDraft, getDraft, listDrafts, publishDraft, updateDraft } from "~/lib/drafts.server";
import { createTopic, softDeleteEntry } from "~/lib/entries.server";
import { drafts, entries, profiles, rateLimits } from "~/lib/db/schema";
import { DRAFT_RATE_LIMIT, MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { getClientDraft } from "~/lib/mcp/drafts.server";
import { changeVillageMembership, ensureLanguageVillages } from "~/lib/villages.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { loader as draftPageLoader } from "~/routes/draft";
import { draftRecoveryToken } from "~/lib/draft-recovery.server";
import { createApiToken } from "~/lib/tokens.server";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); for (const handle of ["writer", "other", "limited", "stopped", "recovery_writer", "recovery_alt"]) await h.signIn(handle, { homeArea: "en" }); });
afterAll(() => h.restore());
afterEach(() => vi.unstubAllEnvs());
const payload = (extra: Record<string, string> = {}, as = "writer") => ({ ownerId: h.ids[as], newTopic: "1", title: "", body: "A private thought", lang: "en", ...extra });
const send = (extra: Record<string, string> = {}, as = "writer") => action(h.args(h.request("/drafts/autosave", { as, form: payload(extra, as) })));
const saved = async (extra: Record<string, string> = {}, as = "writer") => { const res = await send(extra, as); expect(res.status).toBe(200); return res.json(); };

it("requires explicit recovery of a missing draft, preserving its reply context and AI provenance", async () => {
  const owner = "recovery_writer";
  const topic = await createTopic(h.db, h.ids[owner], { body: "Reply context", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const made = await createDraft(h.db, h.ids[owner], { kind: "reply", threadId: topic.id, body: "Original reply", lang: "en", aiAssistance: "draft" }, { via: "api", client: { key: "recovery-client-key", id: "recovery-client", name: "Recovery client", uri: null } });
  if (!made.ok) throw new Error(made.error);
  const loaded = await draftPageLoader(h.args(h.request(`/drafts/${made.id}`, { as: owner }), { id: String(made.id) }));
  await deleteDraft(h.db, h.ids[owner], made.id);
  const fields = { ...payload({ draftId: String(made.id), version: "1", body: "Rescued reply", newTopic: "0" }, owner), recoveryToken: loaded.recoveryToken };
  const recover = (token = fields.recoveryToken, as = owner) => action(h.args(h.request("/drafts/autosave?newdraft=1", { as, form: { ...fields, ownerId: h.ids[as], recoveryToken: token } })));
  const before = await listDrafts(h.db, h.ids[owner]);
  expect((await send(fields, owner)).status).toBe(404);
  expect(await listDrafts(h.db, h.ids[owner])).toEqual(before);
  const response = await recover();
  expect(response.status).toBe(200);
  const replacement = await response.json();
  expect(replacement.id).not.toBe(made.id);
  expect(await getDraft(h.db, h.ids[owner], replacement.id)).toMatchObject({ kind: "reply", threadId: topic.id, body: "Rescued reply", aiAssistance: "draft", via: "web", clientId: "recovery-client", clientName: "Recovery client" });
  expect((await h.db.select().from(drafts).where(eq(drafts.id, replacement.id)))[0]).toMatchObject({ clientKey: null, tokenId: null });
  expect(await getDraft(h.db, h.ids[owner], made.id)).toBeNull();
  const after = await listDrafts(h.db, h.ids[owner]);
  expect((await recover("tampered")).status).toBe(400);
  expect((await recover(fields.recoveryToken, "other")).status).toBe(400);
  expect(await listDrafts(h.db, h.ids[owner])).toEqual(after);
});

it("recovers an alternative framing even when its original question became unreadable", async () => {
  const owner = "recovery_alt";
  const question = await createTopic(h.db, h.ids[owner], { title: "An original question", body: "A question to reframe", lang: "en", asksStance: true });
  if (!question.ok) throw new Error(question.error);
  const made = await createDraft(h.db, h.ids[owner], { kind: "topic", body: "A different framing", lang: "en", asksStance: true, altOf: question.id });
  if (!made.ok) throw new Error(made.error);
  const loaded = await draftPageLoader(h.args(h.request(`/drafts/${made.id}`, { as: owner }), { id: String(made.id) }));
  await softDeleteEntry(h.db, question.id);
  await deleteDraft(h.db, h.ids[owner], made.id);
  const response = await action(h.args(h.request("/drafts/autosave?newdraft=1", { as: owner, form: payload({ draftId: String(made.id), newTopic: "0", asksStance: "1", recoveryToken: loaded.recoveryToken }, owner) })));
  expect(response.status).toBe(200);
  expect(await getDraft(h.db, h.ids[owner], (await response.json()).id)).toMatchObject({ altOf: question.id, altTitle: null, asksStance: true });
});

it("expires recovery after 24 hours and preserves the token identity of API drafts without a client id", async () => {
  const made = await createDraft(h.db, h.ids.recovery_writer, { kind: "topic", body: "API writing", lang: "en" }, { via: "api" });
  if (!made.ok) throw new Error(made.error);
  const draft = (await getDraft(h.db, h.ids.recovery_writer, made.id))!;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const token = await draftRecoveryToken(h.db, h.ids.recovery_writer, draft);
    await deleteDraft(h.db, h.ids.recovery_writer, made.id);
    const recover = () => action(h.args(h.request("/drafts/autosave?newdraft=1", { as: "recovery_writer", form: payload({ newTopic: "0", draftId: String(made.id), recoveryToken: token }, "recovery_writer") })));
    for (const elapsed of [24 * 60 * 60 * 1000 - 1, 24 * 60 * 60 * 1000]) {
      clock.mockReturnValue(now + elapsed);
      const response = await recover();
      expect(response.status).toBe(200);
      expect(await getDraft(h.db, h.ids.recovery_writer, (await response.json()).id)).toMatchObject({ via: "web", clientId: "token:deleted", clientUpdatedAt: draft.updatedAt });
    }
    const before = await listDrafts(h.db, h.ids.recovery_writer);
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    const expired = await recover();
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: "invalid_draft" });
    expect(await listDrafts(h.db, h.ids.recovery_writer)).toEqual(before);
  } finally { clock.mockRestore(); }
});

it("retains a live creating token's id without giving it access to the recovered draft", async () => {
  const token = await createApiToken(h.db, h.ids.recovery_writer, { name: "Recovery token", kind: "draft" });
  if (!token.ok) throw new Error(token.error);
  const made = await createDraft(h.db, h.ids.recovery_writer, { kind: "topic", body: "Token writing", lang: "en" }, { via: "api", tokenId: token.summary.id });
  if (!made.ok) throw new Error(made.error);
  const loaded = await draftPageLoader(h.args(h.request(`/drafts/${made.id}`, { as: "recovery_writer" }), { id: String(made.id) }));
  await deleteDraft(h.db, h.ids.recovery_writer, made.id);
  const response = await action(h.args(h.request("/drafts/autosave?newdraft=1", { as: "recovery_writer", form: payload({ newTopic: "0", draftId: String(made.id), recoveryToken: loaded.recoveryToken }, "recovery_writer") })));
  expect(response.status).toBe(200);
  const replacement = await response.json();
  expect(await getDraft(h.db, h.ids.recovery_writer, replacement.id)).toMatchObject({ clientId: `token:${token.summary.id}`, clientName: "Recovery token" });
  expect((await h.db.select().from(drafts).where(eq(drafts.id, replacement.id)))[0]).toMatchObject({ tokenId: null, clientKey: null });
});

it("ignores empty forms and keeps one web draft across repeated updates without using creation allowance", async () => {
  const before = await listDrafts(h.db, h.ids.writer);
  expect(await (await send({ title: " \n", body: "\t" })).json()).toEqual({ skipped: true });
  expect(await listDrafts(h.db, h.ids.writer)).toHaveLength(before.length);
  const first = await saved();
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ via: "web", version: 1, clientId: null });
  const updated = await saved({ draftId: String(first.id), version: "1", body: "A longer private thought" });
  expect(updated).toMatchObject({ id: first.id, version: 2 });
  await send({ draftId: String(first.id), version: "2", body: "", title: "" });
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ body: "A longer private thought", version: 2 });
  const creation = await h.db.select().from(rateLimits).where(eq(rateLimits.key, `draft:member:${h.ids.writer}`));
  expect(creation.reduce((sum, row) => sum + row.count, 0)).toBe(1);
});

it("recognizes an acknowledged-content replay and a previous lost update before copying a real conflict", async () => {
  const first = await saved();
  const changed = { draftId: String(first.id), version: "1", body: "A change whose response is lost" };
  const accepted = await saved(changed);
  const replay = await saved(changed);
  expect(replay).toMatchObject({ id: first.id, version: accepted.version });
  const newer = await send({ ...changed, body: "Another change while offline", previous: JSON.stringify(Object.entries(payload(changed))) });
  expect(newer.status).toBe(409);
  expect(await newer.json()).toMatchObject({ previousMatches: true, latest: { id: first.id, version: 2, body: changed.body } });
  await updateDraft(h.db, h.ids.writer, first.id, { body: "Someone else's change", lang: "en" }, { expectedVersion: 2 });
  const conflict = await send({ ...changed, body: "My own text" });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ previousMatches: false, latest: { body: "Someone else's change" } });
  const copy = await saved({ ...changed, body: "My own text", fork: "1" });
  expect(copy.id).not.toBe(first.id);
  expect(copy.copied).toBe(true);
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ body: "Someone else's change" });
  const continued = await saved({ draftId: String(copy.id), version: "1", body: "Continued copy" });
  expect(continued).toMatchObject({ id: copy.id, version: 2 });
});

it("returns the existing version without writing identical contents, including a stale replay", async () => {
  const first = await saved();
  const before = await getDraft(h.db, h.ids.writer, first.id);
  for (const version of ["1", "9"]) {
    expect(await saved({ draftId: String(first.id), version })).toMatchObject({ id: first.id, version: 1 });
    expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ version: 1, updatedAt: before!.updatedAt });
  }
});

it("checks an owned saved link without changing it and reports missing or unavailable sessions", async () => {
  const first = await saved();
  const check = (as?: string, id = first.id) => loader(h.args(h.request(`/drafts/autosave?draftId=${id}`, { as })));
  expect(await (await check("writer")).json()).toEqual({ id: first.id, version: 1 });
  expect((await check("other")).status).toBe(404);
  expect((await check()).status).toBe(401);
  await deleteDraft(h.db, h.ids.writer, first.id);
  expect((await check("writer")).status).toBe(404);
});

it("preserves an unopened source language and validates destination access when replaying identical writing", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const first = await saved({ lang: "ja" });
  vi.stubEnv("ENABLED_LANGS", "en");
  const closed = await send({ draftId: String(first.id), version: "1", lang: "ja" });
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ id: first.id, version: 1 });
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ lang: "ja", version: 1 });
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  vi.stubEnv("VILLAGES", "1");
  await ensureLanguageVillages(h.db);
  await changeVillageMembership(h.db, h.ids.writer, "ja", "join");
  const targeted = await saved({ village: "ja", villageExplicit: "1" });
  await changeVillageMembership(h.db, h.ids.writer, "ja", "leave");
  const departed = await send({ draftId: String(targeted.id), version: "1", village: "ja", villageExplicit: "1" });
  expect(departed.status).toBe(400);
  expect(await departed.json()).toEqual({ error: "village_required" });
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ version: 1 });
  expect(await getDraft(h.db, h.ids.writer, targeted.id)).toMatchObject({ version: 1 });
});

it("does not turn a deleted or published draft update into a new creation", async () => {
  for (const publish of [false, true]) {
    const first = await saved();
    if (publish) expect(await publishDraft(h.db, h.ids.writer, first.id)).toMatchObject({ ok: true });
    else await deleteDraft(h.db, h.ids.writer, first.id);
    const before = await listDrafts(h.db, h.ids.writer);
    for (const fork of ["", "1"]) expect((await send({ draftId: String(first.id), version: "1", fork })).status).toBe(404);
    expect(await listDrafts(h.db, h.ids.writer)).toHaveLength(before.length);
  }
});

it("retains the draft on a refused publication and applies separate creation and update caps", async () => {
  const first = await saved({ asksStance: "1" }, "limited");
  expect(await publishDraft(h.db, h.ids.limited, first.id)).toMatchObject({ ok: false, error: "invalid_title" });
  await h.db.update(rateLimits).set({ count: DRAFT_RATE_LIMIT.limit }).where(eq(rateLimits.key, `draft:member:${h.ids.limited}`));
  expect((await send({}, "limited")).status).toBe(429);
  expect((await send({ draftId: String(first.id), version: "1", body: "Still editable", asksStance: "1" }, "limited")).status).toBe(200);
  await h.db.update(rateLimits).set({ count: MEMBER_RATE_LIMITS["draft-autosave"].limit }).where(eq(rateLimits.key, `member:draft-autosave:${h.ids.limited}`));
  const refused = await send({ draftId: String(first.id), version: "2", body: "Keep on this device", asksStance: "1" }, "limited");
  expect(refused.status).toBe(429);
  expect(refused.headers.has("Retry-After")).toBe(true);
  expect(await getDraft(h.db, h.ids.limited, first.id)).toMatchObject({ body: "Still editable" });
});

it("preserves an unspecified personal destination and stores an explicit one only when selected", async () => {
  vi.stubEnv("VILLAGES", "1");
  const first = await saved({ village: "@writer", villageExplicit: "0" });
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ village: null });
  await saved({ draftId: String(first.id), version: "1", body: "More", village: "@writer", villageExplicit: "0" });
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ village: null });
  await updateDraft(h.db, h.ids.writer, first.id, { body: "More", lang: "en", village: "@writer" }, { expectedVersion: 2 });
  const conflict = await send({ draftId: String(first.id), version: "2", body: "More", village: "@writer", villageExplicit: "0" });
  expect(conflict.status).toBe(409);
  const copy = await saved({ draftId: String(first.id), version: "2", body: "More", village: "@writer", villageExplicit: "0", fork: "1" });
  expect(await getDraft(h.db, h.ids.writer, copy.id)).toMatchObject({ village: null });
  await saved({ draftId: String(first.id), version: "3", body: "Explicit", village: "@writer", villageExplicit: "1" });
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ village: "@writer" });
});

it("enforces ownership, session, same-origin, active-member and writer gates", async () => {
  expect((await loader()).status).toBe(405);
  const first = await saved();
  expect((await send({ draftId: String(first.id), version: "1" }, "other")).status).toBe(404);
  expect((await send({ ownerId: h.ids.other })).status).toBe(409);
  expect(await h.outcome(() => action(h.args(h.request("/drafts/autosave", { as: "writer", form: payload(), headers: { origin: "https://foreign.example" } }))))).toMatchObject({ status: 403 });
  expect(await h.outcome(() => action(h.args(h.request("/drafts/autosave", { form: payload() }))))).toMatchObject({ status: 401 });
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, h.ids.stopped));
  const suspended = await send({}, "stopped");
  expect(suspended.status).toBe(403);
  expect(await suspended.json()).toEqual({ error: "suspended" });
  expect((await h.db.select().from(drafts).where(eq(drafts.id, first.id)))[0].authorId).toBe(h.ids.writer);
});

it("preserves AI review metadata and an unreadable immutable original when copying", async () => {
  const origin = await createTopic(h.db, h.ids.writer, { title: "An original question", body: "A question", lang: "en", asksStance: true });
  if (!origin.ok) throw new Error(origin.error);
  const created = await createDraft(h.db, h.ids.writer, { kind: "topic", title: "An alternative", body: "Original AI draft", lang: "en", asksStance: true, altOf: origin.id, aiAssistance: "coauthor" }, { via: "api", client: { key: "oauth:fixture", id: "fixture", name: "Fixture AI", uri: "https://example.org" } });
  if (!created.ok) throw new Error(created.error);
  const initial = (await getDraft(h.db, h.ids.writer, created.id))!;
  await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, origin.id));
  const copy = await saved({ newTopic: "0", draftId: String(created.id), version: "1", fork: "1", title: "A retained alternative", body: "The human's retained copy", asksStance: "1", altOf: "999999" });
  expect(await getDraft(h.db, h.ids.writer, copy.id)).toMatchObject({ via: "web", clientId: "fixture", clientName: "Fixture AI", clientUpdatedAt: initial.clientUpdatedAt, altOf: origin.id, altTitle: null, aiAssistance: "coauthor", body: "The human's retained copy" });
  expect(await getClientDraft(h.db, h.ids.writer, { key: "oauth:fixture", id: "fixture", name: "Fixture AI", uri: "https://example.org", tokenId: null }, copy.id)).toBeNull();
  expect(await publishDraft(h.db, h.ids.writer, copy.id)).toMatchObject({ ok: false, error: "invalid_alt_of" });
  const legacy = await createDraft(h.db, h.ids.writer, { kind: "topic", body: "A token-created draft", lang: "en" }, { via: "api" });
  if (!legacy.ok) throw new Error(legacy.error);
  const retained = await saved({ newTopic: "0", draftId: String(legacy.id), version: "1", fork: "1" });
  expect(await getDraft(h.db, h.ids.writer, retained.id)).toMatchObject({ via: "web", clientId: "token:deleted" });
});

it("accepts just one of two concurrent updates to the same version", async () => {
  const first = await saved();
  const responses = await Promise.all(["The first screen", "The second screen"].map(body => send({ draftId: String(first.id), version: "1", body })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  expect(await getDraft(h.db, h.ids.writer, first.id)).toMatchObject({ version: 2 });
});
