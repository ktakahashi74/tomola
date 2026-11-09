import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createReply, createTopic } from "~/lib/entries.server";
import { createDraft } from "~/lib/drafts.server";
import { entries, memberSignatures, profiles, signingChallenges, roles, moderationActions } from "~/lib/db/schema";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { setStance } from "~/lib/stances.server";
import { attachSigningProof, signingCredential } from "./helpers/signing";
import { buildMemberExport } from "~/lib/exports.server";
import { issueSignedWrite, previewSignedWrite, withSignedWrite } from "~/lib/signing.server";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); });
afterAll(() => h.restore());

it("publishes, replies, edits, changes the handle and publishes drafts without proof by default", async () => {
  const topic = await createTopic(h.db, h.ids.hana, { title: "Original", body: "Original body", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.hana, topic.id, { body: "Original reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  const draft = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "AI draft", lang: "ja" }, { via: "api" });
  if (!draft.ok) throw new Error(draft.error);
  const cases = [
    ["topic-new", "/t/new", {}, { body: "Unsigned topic", lang: "ja" }],
    ["topic", `/t/${topic.id}`, { id: String(topic.id) }, { body: "Unsigned reply", lang: "ja" }],
    ["topic-edit", `/t/${topic.id}/edit`, { id: String(topic.id) }, { title: "New title", body: "Edited topic" }],
    ["reply-edit", `/c/${reply.id}/edit`, { id: String(reply.id) }, { body: "Edited reply" }],
    ["draft", `/drafts/${draft.id}`, { id: String(draft.id) }, { intent: "publish", body: "Reviewed AI draft", lang: "ja" }],
    ["settings", "/settings", {}, { intent: "handle", handle: "new_hana" }],
  ] as const;
  for (const [name, path, params, form] of cases) {
    const mod = await import(`../app/routes/${name}.tsx`);
    expect(await h.outcome(() => mod.action(h.args(h.request(path, { as: "hana", form }), params))), name).toMatchObject({ status: 302 });
  }
  expect((await h.db.select().from(entries).where(eq(entries.id, topic.id)))[0].body).toBe("Edited topic");
  expect((await h.db.select().from(entries).where(eq(entries.id, reply.id)))[0].body).toBe("Edited reply");
  expect((await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle).toBe("new_hana");
  expect(await h.db.select().from(memberSignatures)).toHaveLength(0);
  expect((await buildMemberExport(h.db, h.ids.hana)).profile).toMatchObject({ sign_posts: false });
});

it("ignores even malformed proof when confirmation is off and keeps writes transactional", async () => {
  const form = new FormData(); form.set("body", "Ignored proof"); form.set("lang", "ja");
  form.set("signatureChallenge", "unknown"); form.set("signatureAssertion", "not JSON");
  const request = h.request("/t/new.data", { as: "hana" });
  expect(await withSignedWrite(h.db, h.ids.hana, request, form, tx => createTopic(tx, h.ids.hana, { body: "Ignored proof", lang: "ja" }))).toMatchObject({ ok: true });
  await expect(withSignedWrite(h.db, h.ids.hana, request, form, async tx => {
    await createTopic(tx, h.ids.hana, { body: "Rolled back unsigned post", lang: "ja" });
    throw new Error("mutation failed");
  })).rejects.toThrow("mutation failed");
  expect(await h.db.select().from(entries).where(eq(entries.body, "Rolled back unsigned post"))).toHaveLength(0);
  expect(await h.db.select().from(memberSignatures)).toHaveLength(0);
});

it("previews unsigned content but refuses to issue an unnecessary challenge", async () => {
  const form = new FormData(); form.set("body", "Reviewable text"); form.set("lang", "ja");
  const preview = await previewSignedWrite(h.db, h.ids.hana, "/t/new", form);
  expect(preview).toMatchObject({ signatureRequired: false, enrolled: false, content: { body: "Reviewable text" } });
  await expect(issueSignedWrite(h.db, h.ids.hana, "/t/new", form, preview.payloadHash)).rejects.toMatchObject({ code: "signature_not_required", status: 409 });
  expect(await h.db.select().from(signingChallenges)).toHaveLength(0);
});

it.each(["sign-posts", "delete-passkey"])("still refuses unsigned settings intent %s", async intent => {
  const { action } = await import("~/routes/settings");
  expect(await h.outcome(() => action(h.args(h.request("/settings", { as: "hana", form: { intent, signPosts: "1", passkeyId: "missing" } }))))).toMatchObject({ status: 403, value: { data: { error: "signature_required" } } });
});

it("requires a registered passkey before either preference change and binds both old and new values", async () => {
  await h.signIn("preference_owner");
  const userId = h.ids.preference_owner;
  const form = new FormData(); form.set("intent", "sign-posts"); form.set("signPosts", "1");
  const preview = await previewSignedWrite(h.db, userId, "/settings", form);
  expect(preview.signatureRequired).toBe(true);
  await expect(issueSignedWrite(h.db, userId, "/settings", form, preview.payloadHash)).rejects.toMatchObject({ code: "passkey_required", status: 409 });
  const key = await signingCredential(h.db, userId);
  const { action } = await import("~/routes/settings");
  for (const enabled of [true, false]) {
    const request = h.request("/settings", { as: "preference_owner", form: { intent: "sign-posts", ...(enabled ? { signPosts: "1" } : {}) } });
    const signed = await attachSigningProof(h.db, userId, request, key);
    expect(await h.outcome(() => action(h.args(signed)))).toMatchObject({ status: 302, location: "/settings?saved=sign-posts#settings-signing" });
    expect((await h.db.select().from(profiles).where(eq(profiles.userId, userId)))[0].signPosts).toBe(enabled);
  }
  const records = await h.db.select().from(memberSignatures).where(eq(memberSignatures.userId, userId));
  expect(records).toHaveLength(2);
  expect(records.map(r => JSON.parse(r.payload).input)).toEqual([
    { signPosts: true, previousSignPosts: false }, { signPosts: false, previousSignPosts: true },
  ]);
  expect(records.every(r => r.operation === "change-signing-preference" && r.entryId === null)).toBe(true);
  expect((await buildMemberExport(h.db, userId)).profile?.sign_posts).toBe(false);
});

it("rejects preference tampering and a changed previous value without consuming proof", async () => {
  await h.signIn("preference_tamper");
  const userId = h.ids.preference_tamper; const key = await signingCredential(h.db, userId);
  const form = new FormData(); form.set("intent", "sign-posts"); form.set("signPosts", "1");
  const preview = await previewSignedWrite(h.db, userId, "/settings", form);
  const options = await issueSignedWrite(h.db, userId, "/settings", form, preview.payloadHash);
  form.set("signatureChallenge", options.challenge); form.set("signatureAssertion", JSON.stringify(key.assert(options.options.challenge)));
  const mutate = async () => ({ ok: true });
  form.delete("signPosts");
  await expect(withSignedWrite(h.db, userId, h.request("/settings"), form, mutate)).rejects.toMatchObject({ status: 409 });
  form.set("signPosts", "1");
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, userId));
  await expect(withSignedWrite(h.db, userId, h.request("/settings"), form, mutate)).rejects.toMatchObject({ status: 409 });
  expect((await h.db.select().from(signingChallenges).where(eq(signingChallenges.challenge, options.challenge)))[0].usedAt).toBeNull();
  expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.userId, userId))).toHaveLength(0);
});

it("keeps last-client metadata after an MCP client updates its own draft", async () => {
  const client = { key: "oauth:client", id: "https://ai.example/client.json", name: "AI editor", uri: "https://ai.example", tokenId: null };
  const created = await createClientDraft(h.db, h.ids.hana, client, { kind: "topic", body: "MCP draft", lang: "ja" });
  if (!created.ok) throw new Error(created.error);
  expect(await updateClientDraft(h.db, h.ids.hana, client, created.id, { body: "Last updated by MCP" })).toMatchObject({ ok: true });
  const form = new FormData(); form.set("intent", "publish"); form.set("body", "Last updated by MCP"); form.set("lang", "ja");
  const preview = await previewSignedWrite(h.db, h.ids.hana, `/drafts/${created.id}`, form);
  expect(preview).toMatchObject({ signatureRequired: false, lastEditor: { id: client.id, name: client.name }, content: { body: "Last updated by MCP" } });
});

it("applies the moderator's own preference to corrections and retains the moderation action", async () => {
  await h.signIn("moriko"); await h.signIn("voter");
  await h.db.insert(roles).values({ userId: h.ids.moriko, role: "moderator", lang: "ja" });
  const topic = await createTopic(h.db, h.ids.hana, { title: "Locked question", body: "Typoo", lang: "ja", asksStance: true });
  if (!topic.ok) throw new Error(topic.error);
  expect(await setStance(h.db, h.ids.voter, { questionId: topic.id, position: "agree", expectedVersion: 0 })).toMatchObject({ ok: true });
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.hana));
  try {
    const { loader, action } = await import("~/routes/topic-edit");
    const params = { id: String(topic.id) }; const path = `/t/${topic.id}/edit`;
    const loaded = await loader(h.args(h.request(path, { as: "moriko" }), params));
    expect(loaded).toMatchObject({ fix: true, signPosts: false });
    const post = h.request(path, { as: "moriko", form: { title: "Locked question", body: "Typo", sourceHash: loaded.sourceHash!, note: "Corrected the spelling" } });
    expect(await h.outcome(() => action(h.args(post, params)))).toMatchObject({ status: 302 });
    expect(await h.db.select().from(moderationActions).where(eq(moderationActions.targetEntryId, topic.id))).toHaveLength(1);
    expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, topic.id))).toHaveLength(0);
  } finally { await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, h.ids.hana)); }
});
