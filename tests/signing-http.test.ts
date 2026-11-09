import { beforeAll, afterAll, expect, it } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic, createReply } from "~/lib/entries.server";
import { createDraft } from "~/lib/drafts.server";
import { drafts, entries, memberSignatures, profiles } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.hana)); });
afterAll(() => h.restore());

it("rejects every named HTTP write with a real member session but no signature, preserving all rows", async () => {
  const topic = await createTopic(h.db, h.ids.hana, { title: "Original", body: "Original body", lang: "ja" }); if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.hana, topic.id, { body: "Original reply", lang: "ja" }); if (!reply.ok) throw new Error(reply.error);
  const draft = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Unpublished draft", lang: "ja" }); if (!draft.ok) throw new Error(draft.error);
  const cases = [
    ["topic-new", "/t/new", {}, { body: "Forged topic", lang: "ja" }],
    ["topic", `/t/${topic.id}`, { id: String(topic.id) }, { body: "Forged reply", lang: "ja" }],
    ["topic-edit", `/t/${topic.id}/edit`, { id: String(topic.id) }, { title: "Forged title", body: "Forged edit" }],
    ["reply-edit", `/c/${reply.id}/edit`, { id: String(reply.id) }, { body: "Forged reply edit" }],
    ["draft", `/drafts/${draft.id}`, { id: String(draft.id) }, { intent: "publish", body: "Forged draft publication", lang: "ja" }],
    ["settings", "/settings", {}, { intent: "handle", handle: "forged" }],
  ] as const;
  const before = await h.db.select().from(entries);
  const draftBefore = await h.db.select().from(drafts);
  for (const [name, path, params, form] of cases) {
    const mod = await import(`../app/routes/${name}.tsx`);
    const request = h.request(path, { as: "hana", form });
    expect(request.method).toBe("POST");
    expect(await h.outcome(() => mod.action(h.args(request, params))), name).toMatchObject({ status: 403 });
  }
  expect(await h.db.select().from(entries)).toEqual(before);
  expect(await h.db.select().from(drafts)).toEqual(draftBefore);
  expect((await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle).toBe("hana");
  expect(await h.db.select().from(memberSignatures)).toHaveLength(0);
});

it("refuses an invalid signing proof through all six write paths without changing posts, drafts or the handle", async () => {
  const topic = await createTopic(h.db, h.ids.hana, { body: "Original signed target", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.hana, topic.id, { body: "Original reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  const draft = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Unpublished draft", lang: "ja" });
  if (!draft.ok) throw new Error(draft.error);
  const before = await h.db.select().from(entries);
  const draftBefore = await h.db.select().from(drafts);
  const handleBefore = (await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle;
  const version = String(draftBefore.find(row => row.id === draft.id)!.version);
  for (const [name, url, params, form] of [
    ["topic-new", "/t/new", {}, { body: "Forged topic", lang: "ja" }],
    ["topic", `/t/${topic.id}`, { id: String(topic.id) }, { body: "Forged reply", lang: "ja" }],
    ["topic-edit", `/t/${topic.id}/edit`, { id: String(topic.id) }, { body: "Forged edit", lang: "ja" }],
    ["reply-edit", `/c/${reply.id}/edit`, { id: String(reply.id) }, { body: "Forged reply edit", lang: "ja" }],
    ["draft", `/drafts/${draft.id}`, { id: String(draft.id) }, { intent: "publish", body: "Forged draft publication", lang: "ja", version }],
    ["settings", "/settings", {}, { intent: "handle", handle: "forged" }],
  ] as const) {
    const mod = await import(`../app/routes/${name}.tsx`);
    const response = await h.outcome(() => mod.action(h.args(h.request(url, { as: "hana", form: { ...form, signatureChallenge: "invalid", signatureAssertion: "invalid-json" } }), params)));
    expect(response.status, name).toBe(403);
    expect(response.value, name).toMatchObject({ data: { error: "invalid_signature" } });
    expect(await h.db.select().from(entries), name).toEqual(before);
    expect(await h.db.select().from(drafts), name).toEqual(draftBefore);
    expect((await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle, name).toBe(handleBefore);
    expect(await h.db.select().from(memberSignatures), name).toHaveLength(0);
  }
});
