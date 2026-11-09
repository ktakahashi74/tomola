import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderInRouter } from "./helpers/render-in-router";
import { m } from "~/paraglide/messages.js";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { eq } from "drizzle-orm";
import { profiles, signingChallenges } from "~/lib/db/schema";
import { createTopic, createReply } from "~/lib/entries.server";
import { createDraft } from "~/lib/drafts.server";
import { draftScreenForm } from "./helpers/draft-form";
import { MEMBER_RATE_LIMITS, hitRateLimit } from "~/lib/rate-limit.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
let topicId: number;
let replyId: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("safety_author");
  await h.signIn("safety_reader");
  const topic = await createTopic(h.db, h.ids.safety_author, { body: "Original topic", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  topicId = topic.id;
  const reply = await createReply(h.db, h.ids.safety_author, topicId, { body: "Original reply", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  replyId = reply.id;
});
afterAll(() => h.restore());

it("returns every invalid new-post value for a native form post", async () => {
  const { action } = await import("~/routes/topic-new");
  for (const form of [
    { title: "Retained title", body: "Retained text", lang: "xx" },
    { title: "Retained title", body: "---\nlang: xx\n---\nRetained text", lang: "" },
    { title: "Retained title", body: "x".repeat(50001), lang: "en" },
  ]) {
    const result = await action(h.args(h.request("/t/new", { as: "safety_reader", form })));
    expect(result.data.values).toMatchObject(form);
    expect(result.data.error).toBeTruthy();
    expect(result.init?.status).toBe(400);
  }
});

it("returns signing refusals to each editor with the submitted body", async () => {
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.safety_author));
  const cases = [
    ["topic-new", "/t/new", {}, { body: "Unsent topic", lang: "en" }],
    ["topic", `/t/${topicId}`, { id: String(topicId) }, { body: "Unsent reply", lang: "en" }],
    ["topic-edit", `/t/${topicId}/edit`, { id: String(topicId) }, { title: "New title", body: "Unsent topic edit" }],
    ["reply-edit", `/c/${replyId}/edit`, { id: String(replyId) }, { body: "Unsent reply edit" }],
  ] as const;
  try {
    for (const [name, path, params, form] of cases) {
      const route = await import(`../app/routes/${name}.tsx`);
      // Call directly: thrown Responses would replace the editor with the route boundary.
      const result = await route.action(h.args(h.request(path, { as: "safety_author", form }), params));
      expect(result.data.error, name).toBe("signature_required");
      expect((result.data.values ?? result.data.input).body, name).toBe(form.body);
      expect(result.init.status).toBe(403);
    }
  } finally { await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, h.ids.safety_author)); }
});

it("returns vote refusals as data and limits each member without changing a vote", async () => {
  const { action } = await import("~/routes/vote");
  const vote = (as: string, entryId: number, on = "1") => action(h.args(h.request("/vote", { as, form: { entryId: String(entryId), on } })));
  expect((await vote("safety_author", topicId)).data).toMatchObject({ ok: false, error: "own_entry" });
  expect((await vote("safety_reader", 999999)).data).toMatchObject({ ok: false, error: "not_found" });
  // Pre-fill the same member bucket without spending thirty writes on unrelated posts.
  for (let i = 1; i < MEMBER_RATE_LIMITS.stance.limit; i++) await hitRateLimit(h.db, { key: `member:vote:${h.ids.safety_reader}`, ...MEMBER_RATE_LIMITS.stance });
  const refused = await vote("safety_reader", topicId);
  expect(refused.data).toMatchObject({ ok: false, error: "rate_limited" });
  expect(refused.init?.status).toBe(429);
  expect(refused.init?.headers).toHaveProperty("Retry-After");
  expect((await vote("safety_author", replyId)).init?.status).toBe(403);
});

it("retains a draft and settings input on signing refusal, and retains an expired signed post", async () => {
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.safety_author));
  try {
    const draft = await createDraft(h.db, h.ids.safety_author, { kind: "topic", body: "Saved draft", lang: "en" });
    if (!draft.ok) throw new Error(draft.error);
    const draftRoute = await import("~/routes/draft");
    const form = await draftScreenForm(h.db, h.ids.safety_author, draft.id, { intent: "publish", body: "Unsent draft edit", lang: "en" });
    const refused = await draftRoute.action(h.args(h.request(`/drafts/${draft.id}`, { as: "safety_author", form }), { id: String(draft.id) }));
    expect(refused.data).toMatchObject({ error: "signature_required", saved: false, values: { body: "Unsent draft edit" } });
    const settings = await import("~/routes/settings");
    const handle = await settings.action(h.args(h.request("/settings", { as: "safety_author", form: { intent: "handle", handle: "safety_changed" } })));
    expect("data" in handle ? handle.data : null).toMatchObject({ error: "signature_required", handleValue: "safety_changed" });
    const topic = await import("~/routes/topic-new");
    const signed = await h.signedArgs(h.request("/t/new", { as: "safety_author", form: { body: "An expired signed post", lang: "en" } }));
    await h.db.update(signingChallenges).set({ createdAt: new Date(Date.now() - 180_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(signingChallenges.userId, h.ids.safety_author));
    const expired = await topic.action(signed);
    expect(expired.data).toMatchObject({ error: "challenge_expired", values: { body: "An expired signed post" } });
    expect(expired.init?.status).toBe(403);
  } finally { await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, h.ids.safety_author)); }
});

it("shows a personal destination to an unjoined member without removing the fields", async () => {
  vi.stubEnv("VILLAGES", "1");
  try {
    await ensureLanguageVillages(h.db);
    await h.signIn("safety_outsider", { homeArea: "other", readLangs: ["en"] });
    const { loader, default: TopicNew } = await import("~/routes/topic-new");
    const loaderData = await loader(h.args(h.request("/t/new", { as: "safety_outsider" })));
    expect(loaderData.posting?.choices).toMatchObject([{ kind: "personal", slug: "@safety_outsider" }]);
    const html = await renderInRouter(() => createElement(TopicNew, { loaderData, actionData: undefined, params: {}, matches: [] } as never), "/t/new");
    expect(html).not.toContain(m.village_required());
    expect(html).toContain('name="village"');
    expect(html).toContain('name="body"');
  } finally { vi.unstubAllEnvs(); }
});

it("returns the saved draft version and signing view after publication validation fails", async () => {
  const draft = await createDraft(h.db, h.ids.safety_reader, { kind: "topic", body: "Saved before publication", lang: "en" });
  if (!draft.ok) throw new Error(draft.error);
  const route = await import("~/routes/draft");
  const params = { id: String(draft.id) };
  const path = `/drafts/${draft.id}`;
  const form = await draftScreenForm(h.db, h.ids.safety_reader, draft.id, { intent: "publish", title: "", body: "An incomplete question", asksStance: "1", lang: "en" });
  const result = await route.action(h.args(h.request(path, { as: "safety_reader", form }), params));
  expect(result.data).toMatchObject({ error: "invalid_title", saved: true, version: 2, values: { version: "2", body: form.body } });
  expect(result.data.values!.signingView).toBe(result.data.signingView);
  const next = await route.action(h.args(h.request(path, { as: "safety_reader", form: { ...form, intent: "save", title: "A complete question", version: result.data.values!.version, signingView: result.data.values!.signingView } }), params));
  expect(next.data).toMatchObject({ error: null, saved: true, version: 3 });
});
