import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { profiles, villages, handleHolds, villageFollows, villageMembers, entries, translations } from "~/lib/db/schema";
import MemberPage from "~/routes/member-page";
import { renderInRouter } from "./helpers/render-in-router";
import { personalVillage, ensurePersonalVillage } from "~/lib/personal-villages.server";
import { changeHandle } from "~/lib/profiles.server";
import { changeVillageMembership, ensureLanguageVillages, languageVillage, listVillages, postingVillages, setDefaultVillage, villageForTopic, villageBySlug, topicVillageNames } from "~/lib/villages.server";
import { prepareVillages } from "~/lib/villages-prepare.server";
import { createTopic, createReply, getThread, listTopics } from "~/lib/entries.server";
import { submitTopicForm } from "~/lib/entry-form.server";
import { createDraft, getDraft, publishDraft } from "~/lib/drafts.server";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { canReadThreadPublicly } from "~/lib/md/thread.server";
import { setVillageFollow, listFollowedVillages } from "~/lib/village-follows.server";
import { loadMemberPageContent, resolveMemberPage, setIntroduction } from "~/lib/member-pages.server";
import { endVillage, editVillage, inviteToVillage } from "~/lib/village-management.server";
import { chatAccess, acceptChatConsent, mutateChat } from "~/lib/village-chat.server";
import { createVillageReport, moderateVillage } from "~/lib/village-moderation.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { requestVillageTranslations, planVillageTexts } from "~/lib/village-translations.server";

const input = { title: "An owned post", body: "The personal village fixture.", lang: "en" };
const client = { key: "oauth:personal", id: "personal", name: "Fixture", uri: null, tokenId: null };
afterEach(() => vi.unstubAllEnvs());
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "pv-owner", "pv_owner", { homeArea: "en" });
  await addMember(db, "pv-reader", "pv_reader", { homeArea: "other", readLangs: ["en"] });
  const village = (await personalVillage(db, "pv-owner"))!;
  return { db, village };
}
async function post(db: Awaited<ReturnType<typeof createTestDb>>, author = "pv-owner", village?: string) {
  const result = await createTopic(db, author, { ...input, ...(village ? { village } : {}) });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}

it("creates a nameless immutable destination and default for every registration even with villages disabled", async () => {
  vi.stubEnv("VILLAGES", "");
  const db = await createTestDb();
  await addMember(db, "pv-disabled", "pv_disabled");
  const village = (await personalVillage(db, "pv-disabled"))!;
  expect(village).toMatchObject({ kind: "personal", ownerId: "pv-disabled", slug: null, language: null, sourceLang: null, name: "", description: "", system: false });
  expect((await db.select().from(profiles))[0].defaultVillageId).toBe(village.id);
  await Promise.all([ensurePersonalVillage(db, "pv-disabled"), ensurePersonalVillage(db, "pv-disabled")]);
  expect(await db.select().from(villages)).toHaveLength(1);
  for (const patch of [{ slug: "personal-slug" }, { name: "Named" }, { description: "Description" }, { sourceLang: "en" }, { system: true }, { ownerId: null }, { kind: "open" }]) {
    await expect(db.update(villages).set(patch).where(eq(villages.id, village.id))).rejects.toThrow();
  }
  await expect(db.insert(villages).values({ kind: "personal", ownerId: "pv-disabled", endedAt: new Date() })).rejects.toThrow();
});

it("preserves language membership while choosing the personal default, with an unset default also resolving there", async () => {
  const { db, village } = await world();
  expect((await db.select().from(profiles).where(eq(profiles.userId, "pv-owner")))[0].defaultVillageId).toBe(village.id);
  expect(await db.select().from(villageMembers).where(eq(villageMembers.userId, "pv-owner"))).toHaveLength(1);
  await db.update(profiles).set({ defaultVillageId: null }).where(eq(profiles.userId, "pv-owner"));
  await changeVillageMembership(db, "pv-owner", "ja", "join");
  expect((await db.select().from(profiles).where(eq(profiles.userId, "pv-owner")))[0].defaultVillageId).toBeNull();
  const id = await post(db);
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0].villageId).toBe(village.id);
  const choices = await postingVillages(db, "pv-owner");
  expect(choices.selected).toBe("@pv_owner");
  expect(choices.choices[0]).toMatchObject({ kind: "personal", slug: "@pv_owner" });
  expect(await setDefaultVillage(db, "pv-owner", "en")).toBe(true);
  const shared = await post(db);
  expect((await db.select().from(entries).where(eq(entries.id, shared)))[0].villageId).toBe((await languageVillage(db, "en"))!.id);
});

it("rejects another owner's destination in topic, browser draft, API draft, MCP and stored-ID paths", async () => {
  const { db, village } = await world();
  expect(await createTopic(db, "pv-reader", { ...input, village: "@pv_owner" })).toMatchObject({ ok: false, error: "village_required" });
  for (const via of ["web", "api"] as const) expect(await createDraft(db, "pv-reader", { kind: "topic", ...input, village: "@pv_owner" }, { via })).toMatchObject({ ok: false, error: "village_required" });
  expect(await createClientDraft(db, "pv-reader", client, { kind: "topic", ...input, village: "@pv_owner" })).toMatchObject({ ok: false, error: "village_required" });
  expect(await db.transaction(tx => villageForTopic(tx, "pv-reader", undefined, village.id))).toBeNull();
  expect(await db.select().from(entries)).toEqual([]);
  expect(await listVillages(db)).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "personal" })]));
  expect(await villageBySlug(db, "@pv_owner")).toBeNull();
});

it("keeps an explicit draft destination, but resolves an omitted destination only at publication", async () => {
  const { db, village } = await world();
  const implicit = await createDraft(db, "pv-owner", { kind: "topic", ...input });
  const explicit = await createClientDraft(db, "pv-owner", client, { kind: "topic", ...input, village: "@pv_owner" });
  if (!implicit.ok || !explicit.ok) throw new Error("draft failed");
  expect((await getDraft(db, "pv-owner", implicit.id))?.village).toBeNull();
  await setDefaultVillage(db, "pv-owner", "en");
  const cleared = await createClientDraft(db, "pv-owner", client, { kind: "topic", ...input, village: "@pv_owner" });
  if (!cleared.ok) throw new Error("draft failed");
  expect(await updateClientDraft(db, "pv-owner", client, cleared.id, { village: null })).toMatchObject({ ok: true });
  expect((await getDraft(db, "pv-owner", cleared.id))?.village).toBeNull();
  const published = await publishDraft(db, "pv-owner", implicit.id);
  const owned = await publishDraft(db, "pv-owner", explicit.id);
  if (!published.ok || !owned.ok) throw new Error("publish failed");
  expect((await db.select().from(entries).where(eq(entries.id, published.id)))[0].villageId).toBe((await languageVillage(db, "en"))!.id);
  expect((await db.select().from(entries).where(eq(entries.id, owned.id)))[0].villageId).toBe(village.id);
});

it("restores an unavailable default to the personal village and consumes its notice only on the writing screen", async () => {
  const { db, village } = await world();
  await changeVillageMembership(db, "pv-owner", "ja", "join");
  await setDefaultVillage(db, "pv-owner", "ja");
  await changeVillageMembership(db, "pv-owner", "ja", "leave");
  expect((await postingVillages(db, "pv-owner", undefined, { repair: false })).changed).toBe(false);
  expect(await postingVillages(db, "pv-owner")).toMatchObject({ changed: true, selected: "@pv_owner" });
  expect((await postingVillages(db, "pv-owner")).changed).toBe(false);
  const [ended] = await db.insert(villages).values({ kind: "open", slug: "ended-personal-default", endedAt: new Date() }).returning();
  await db.update(profiles).set({ defaultVillageId: ended.id }).where(eq(profiles.userId, "pv-owner"));
  expect(await postingVillages(db, "pv-owner")).toMatchObject({ changed: true, selected: "@pv_owner" });
  expect((await db.select().from(profiles).where(eq(profiles.userId, "pv-owner")))[0].defaultVillageId).toBe(village.id);
});

it("allows public reading and member replies, while following delivers only posts placed in the personal village", async () => {
  const { db } = await world();
  const ownId = await post(db);
  const elsewhereId = await post(db, "pv-owner", "en");
  const names = await topicVillageNames(db, [ownId, elsewhereId]);
  expect(names.has(ownId)).toBe(false);
  expect(names.has(elsewhereId)).toBe(false);
  expect(await canReadThreadPublicly(db, ownId)).toBe(true);
  expect(await getThread(db, ownId)).not.toBeNull();
  expect(await createReply(db, "pv-reader", ownId, { body: "A public reply.", lang: "en" })).toMatchObject({ ok: true });
  await setVillageFollow(db, "pv-reader", "@pv_owner", true);
  const listed = await listFollowedVillages(db, "pv-reader");
  expect(listed).toMatchObject([{ kind: "personal", slug: "@pv_owner", name: "@pv_owner" }]);
  const home = await listTopics(db, { kind: "my-villages", userId: "pv-reader" });
  expect(home.topics.map(t => t.id)).toEqual([ownId]);
  expect(home.topics.map(t => t.id)).not.toContain(elsewhereId);
  const member = (await resolveMemberPage(db, "pv_owner"))!;
  const content = await loadMemberPageContent(db, member, { viewerId: "pv-reader", readLangs: ["en"], displayLang: "en", page: 1 });
  expect(content.personal?.following).toBe(true);
  expect(content.personal?.topics.map(t => t.id)).toEqual([ownId]);
  expect(content.topics.map(t => t.id)).toEqual([elsewhereId]);
  expect(content.topics[0].village?.slug).toBe("en");
  await changeHandle(db, "pv-owner", "pv_renamed");
  const renamed = await postingVillages(db, "pv-owner");
  expect(renamed.ownHandle).toBe("pv_renamed");
  expect(renamed.choices[0].slug).toBe("@pv_renamed");
  expect((await listFollowedVillages(db, "pv-reader"))[0].slug).toBe("@pv_renamed");
  await setVillageFollow(db, "pv-reader", "@pv_renamed", false);
  expect(await listFollowedVillages(db, "pv-reader")).toEqual([]);
});

it("omits language-village names on member rows while keeping community and organization names", async () => {
  const { db } = await world();
  const places = await db.insert(villages).values([
    { slug: "pv-community", name: "Community place", kind: "open" },
    { slug: "pv-organization", name: "Organization place", kind: "invite_public" },
  ]).returning();
  await db.insert(villageMembers).values(places.map(place => ({ userId: "pv-owner", villageId: place.id })));
  for (const target of ["en", ...places.map(place => place.slug!)]) await post(db, "pv-owner", target);
  const member = (await resolveMemberPage(db, "pv_owner"))!;
  const content = await loadMemberPageContent(db, member, { viewerId: "pv-reader", readLangs: ["en"], displayLang: "en", page: 1 });
  const html = await renderInRouter(() => createElement(MemberPage, { loaderData: content, actionData: undefined, params: {}, matches: [] } as never), "/u/pv_owner");
  expect(html).not.toContain('href="/v/en"');
  for (const place of places) {
    expect(html).toContain(`href="/v/${place.slug}"`);
    expect(html).toContain(place.name);
  }
});

it("refuses shared-village management, chat, reports, and translations for a personal village", async () => {
  const { db, village } = await world();
  expect(await changeVillageMembership(db, "pv-reader", "@pv_owner", "join")).toBe(false);
  expect(await changeVillageMembership(db, "pv-owner", "@pv_owner", "leave")).toBe(false);
  for (const result of [await endVillage(db, "pv-owner", "@pv_owner"), await editVillage(db, "pv-owner", "@pv_owner", { name: "Named", description: "" }), await inviteToVillage(db, "pv-owner", "@pv_owner", "pv_reader", "owner")]) expect(result.ok).toBe(false);
  expect(await chatAccess(db, "@pv_owner", "pv-owner")).toBeNull();
  await expect(acceptChatConsent(db, "pv-owner", "@pv_owner")).rejects.toBeDefined();
  await expect(mutateChat(db, "pv-owner", "@pv_owner", "send", { body: "No chat" })).rejects.toBeDefined();
  expect(await createVillageReport(db, "pv-reader", { slug: "@pv_owner", reason: "other" })).toMatchObject({ ok: false });
  expect(await moderateVillage(db, { id: "pv-reader", scope: { operator: true, langs: [] } }, { slugTarget: "@pv_owner", version: "0", intent: "end", reason: "other" })).toMatchObject({ ok: false });
  expect(await requestVillageTranslations(db, village.id)).toBe(0);
  expect((await planVillageTexts(db)).fill).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: village.id })]));
});

it("excludes closed posts and memberships from member pages, introductions and follow collections even for a member", async () => {
  const { db } = await world();
  const [closed] = await db.insert(villages).values({ slug: "hidden-personal-fixture", name: "Secret place", kind: "closed" }).returning();
  const [secret] = await db.insert(entries).values({ kind: "topic", authorId: "pv-owner", villageId: closed.id, lang: "en", title: "Secret title", body: "Secret body" }).returning();
  await db.insert(villageMembers).values([{ userId: "pv-owner", villageId: closed.id }, { userId: "pv-reader", villageId: closed.id }]);
  await db.insert(villageFollows).values({ userId: "pv-reader", villageId: closed.id });
  await db.update(profiles).set({ introEntryId: secret.id }).where(eq(profiles.userId, "pv-owner"));
  expect(await setIntroduction(db, "pv-owner", secret.id)).toMatchObject({ ok: false });
  for (const viewerId of ["pv-owner", "pv-reader"]) {
    const member = (await resolveMemberPage(db, "pv_owner"))!;
    const content = await loadMemberPageContent(db, member, { viewerId, readLangs: ["en"], displayLang: "en", page: 1 });
    expect(content.intro).toBeNull();
    expect(JSON.stringify(content)).not.toMatch(/Secret|hidden-personal-fixture/);
  }
  expect(await listFollowedVillages(db, "pv-reader")).toEqual([]);
  expect((await listTopics(db, { kind: "my-villages", userId: "pv-reader" })).topics).toEqual([]);
});

it("ends a departing owner's village, clears its follows, preserves posts and does not transfer a reused handle", async () => {
  const { db, village } = await world();
  const id = await post(db);
  await setVillageFollow(db, "pv-reader", "@pv_owner", true);
  await deleteAccount(db, "pv-owner", { confirmation: "pv_owner", posts: "keep" });
  expect(await personalVillage(db, "pv-owner")).toBeNull();
  expect(await db.select().from(villages).where(eq(villages.ownerId, "pv-owner"))).toEqual([]);
  const [ended] = await db.select().from(villages).where(eq(villages.id, village.id));
  expect(ended.endedAt).not.toBeNull();
  expect(ended.ownerId).toBe(`ended:${village.id}`);
  await expect(ensurePersonalVillage(db, "pv-owner")).rejects.toThrow("existing member");
  expect(await db.select().from(villageFollows).where(eq(villageFollows.villageId, village.id))).toEqual([]);
  expect(await getThread(db, id)).not.toBeNull();
  expect(await createReply(db, "pv-reader", id, { body: "Reply after ending.", lang: "en" })).toMatchObject({ ok: true });
  await db.update(handleHolds).set({ heldUntil: new Date(0) });
  await addMember(db, "pv-new", "pv_owner", { homeArea: "en" });
  expect((await personalVillage(db, "pv-new"))?.id).not.toBe(village.id);
  expect(await db.select().from(villageFollows).where(and(eq(villageFollows.userId, "pv-reader"), eq(villageFollows.villageId, (await personalVillage(db, "pv-new"))!.id)))).toEqual([]);
});

it("keeps large follow collections bounded and reaches the remainder without exposing closed villages", async () => {
  const { db } = await world();
  const rows = await db.insert(villages).values(Array.from({ length: 202 }, (_, n) => ({ slug: `personal-page-${n}`, kind: n === 201 ? "closed" : "open", name: `Page ${n}` }))).returning();
  await db.insert(villageFollows).values(rows.map((row, n) => ({ userId: "pv-reader", villageId: row.id, createdAt: new Date(1_700_000_000_000 + n) })));
  const first = await listFollowedVillages(db, "pv-reader");
  const next = await listFollowedVillages(db, "pv-reader", { page: 2 });
  expect(first).toHaveLength(200);
  expect(next).toHaveLength(1);
  expect(new Set([...first, ...next].map(row => row.slug)).size).toBe(201);
  expect(JSON.stringify([first, next])).not.toContain("personal-page-201");
});

it("rejects an explicitly empty browser destination instead of publishing into the default", async () => {
  const { db } = await world();
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...input, village: "", villageExplicit: "1", villageDisplayed: "@pv_owner" })) form.set(key, value);
  expect(await submitTopicForm(db, { user: { id: "pv-owner" }, profile: { homeArea: "en", readLangs: ["en"] } }, form)).toMatchObject({ ok: false, error: "village_required" });
  expect(await db.select().from(entries)).toEqual([]);
});

it("preparation preserves an existing member's unset default", async () => {
  const { db, village } = await world();
  await db.update(profiles).set({ defaultVillageId: null, villagePreparedAt: null }).where(eq(profiles.userId, "pv-owner"));
  const plan = await prepareVillages(db, { write: true, env: { ENABLED_LANGS: "en,ja" } });
  expect(plan.defaults).toBe(0);
  expect((await db.select().from(profiles).where(eq(profiles.userId, "pv-owner")))[0].defaultVillageId).toBeNull();
  const id = await post(db);
  expect((await db.select().from(entries).where(eq(entries.id, id)))[0].villageId).toBe(village.id);
});

it("keeps the two member-page sections on independent pages and author reading counts private", async () => {
  const { db, village } = await world();
  const shared = (await languageVillage(db, "en"))!;
  const seed = async (villageId: string) => db.insert(entries).values(Array.from({ length: 21 }, (_, i) => ({ kind: "topic", authorId: "pv-owner", villageId, lang: "en", title: `Paged post ${i}`, body: "Owned paging fixture." }))).returning({ id: entries.id, sourceHash: entries.sourceHash });
  const personalRows = await seed(village.id), otherRows = await seed(shared.id);
  await db.insert(translations).values([personalRows[20], otherRows[20]].map(row => ({ entryId: row.id, field: "body", lang: "ja", kind: "primary", text: "翻訳", engine: "fake", model: "fake-1", sourceHash: row.sourceHash, everSeen: true })));
  const member = (await resolveMemberPage(db, "pv_owner"))!;
  const read = { viewerId: "pv-owner", readLangs: ["en"] as const, displayLang: "en" as const, page: 1 };
  const first = await loadMemberPageContent(db, member, read);
  const personalNext = await loadMemberPageContent(db, member, { ...read, personalPage: 2 });
  const otherNext = await loadMemberPageContent(db, member, { ...read, page: 2 });
  expect(personalNext.personal?.topics.map(row => row.id)).toEqual([personalRows[0].id]);
  expect(personalNext.topics).toEqual(first.topics);
  expect(otherNext.personal?.topics).toEqual(first.personal?.topics);
  expect(otherNext.topics.map(row => row.id)).toEqual([otherRows[0].id]);
  expect(first.personal?.topics[0].readLanguageCount).toBe(1);
  expect(first.topics[0].readLanguageCount).toBe(1);
  const visitor = await loadMemberPageContent(db, member, { ...read, viewerId: "pv-reader" });
  expect([...visitor.topics, ...visitor.personal!.topics].every(row => !("readLanguageCount" in row))).toBe(true);
  const html = await renderInRouter(() => createElement(MemberPage, { loaderData: first, actionData: undefined, params: {}, matches: [] } as never), "/u/pv_owner?page=1&vpage=1");
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), "https://fixture.invalid"));
  expect(links.filter(link => link.hash === "#village").map(link => [link.searchParams.get("page"), link.searchParams.get("vpage")])).toEqual([["1", "2"]]);
  expect(links.filter(link => link.hash === "#posts").map(link => [link.searchParams.get("page"), link.searchParams.get("vpage")])).toEqual([["2", "1"]]);
});

it("requires destination review when an implicit post's previously displayed default becomes unavailable", async () => {
  const { db } = await world();
  expect(await setDefaultVillage(db, "pv-owner", "en")).toBe(true);
  await db.delete(villageMembers).where(eq(villageMembers.userId, "pv-owner"));
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...input, village: "en", villageExplicit: "0", villageDisplayed: "en" })) form.set(key, value);
  expect(await submitTopicForm(db, { user: { id: "pv-owner" }, profile: { homeArea: "en", readLangs: ["en"] } }, form)).toMatchObject({ ok: false, error: "village_changed", village: "@pv_owner" });
  expect(await db.select().from(entries)).toEqual([]);
});
