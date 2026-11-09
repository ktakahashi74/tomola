import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTopic, createReply } from "~/lib/entries.server";
import { entries, notifications, profiles, user, villageMembers, villages } from "~/lib/db/schema";
import { responsePostPrefill } from "~/lib/response-post.server";
import { DELETED_MEMBER_HANDLE, DELETED_MEMBER_ID, DELETED_MEMBER_EMAIL } from "~/lib/deleted-member";
import { parseEntryReferences } from "~/lib/entry-references.server";
import { mentionTokens } from "~/lib/mentions-md.server";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { ensureLanguageVillages, enrollInVillage, languageVillage, setDefaultVillage } from "~/lib/villages.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
let original: number;
let untitled: number;
let reply: number;
const sourceTitle = "Original [title] *literal* @zsource &amp; text";
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("zsource", { homeArea: "en" });
  await h.signIn("zresponder", { homeArea: "ja" });
  const topic = await createTopic(h.db, h.ids.zsource, { lang: "en", title: sourceTitle, body: "Source material" });
  const short = await createTopic(h.db, h.ids.zsource, { lang: "en", body: "A post without a title" });
  if (!topic.ok || !short.ok) throw new Error("Topic fixture failed");
  original = topic.id;
  untitled = short.id;
  const res = await createReply(h.db, h.ids.zsource, original, { lang: "en", body: "A reply" });
  if (!res.ok) throw new Error(res.error);
  reply = res.id;
});
afterAll(() => h.restore());
afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });
const editor = async (query: string) => {
  const { loader } = await import("~/routes/topic-new");
  return loader(h.args(h.request(`/t/new${query}`, { as: "zresponder" })));
};
const thread = async (id: number, as?: string) => {
  const { loader } = await import("~/routes/topic");
  return loader(h.args(h.request(`/t/${id}`, { as }), { id: String(id) }));
};

it("prefills the body in the screen language, using the source title literally, without changing the title or posting language", async () => {
  for (const locale of ["en", "ja"] as const) {
    const response = await responsePostPrefill(h.db, String(original), locale);
    expect(response?.prefill.title).toBe("");
    const body = response!.prefill.body;
    expect(body.endsWith("\n\n")).toBe(true);
    expect(body).toContain("Original \\[title\\] \\*literal\\* @zsource");
    expect(await markdownToPlainText(body)).toContain(sourceTitle);
    expect(await parseEntryReferences(body)).toEqual([expect.objectContaining({ topicId: original, entryId: original, kind: "topic" })]);
    expect(await mentionTokens(body)).toEqual([]);
  }
  const plain = await editor("");
  const response = await editor(`?respond=${original}`);
  expect(response.prefill).toMatchObject({ title: "", body: expect.stringContaining(`/t/${original}`) });
  expect(response.defaultLang).toBe(plain.defaultLang);
  expect(response.asksStance).toBe(plain.asksStance);
  expect(response.responsePlaceHint).toBeNull();
  // Interface language and preferred reading language are independent.
  await h.db.update(profiles).set({ displayLang: "en" }).where(eq(profiles.userId, h.ids.zresponder));
  setTestLocale("ja");
  const japanese = await editor(`?respond=${original}`);
  expect(japanese.prefill).toEqual((await responsePostPrefill(h.db, String(original), "ja"))!.prefill);
  expect(japanese.defaultLang).toBe(plain.defaultLang);
});

it("uses an author's post link for untitled topics and creates no default mention notification", async () => {
  const response = await responsePostPrefill(h.db, String(untitled), "ja");
  expect(response!.prefill.body).toContain("@zsource");
  expect(await mentionTokens(response!.prefill.body)).toEqual([]);
  const published = await createTopic(h.db, h.ids.zresponder, { lang: "ja", body: response!.prefill.body + "My response" });
  if (!published.ok) throw new Error(published.error);
  expect(await h.db.select().from(notifications).where(and(eq(notifications.userId, h.ids.zsource), eq(notifications.kind, "mention")))).toEqual([]);
  const opts = { readLangs: ["en" as const], displayLang: "en" as const };
  expect((await listRelatedDiscussions(h.db, untitled, opts)).rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: published.id })]));
  expect((await listRelatedDiscussions(h.db, published.id, opts)).rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: untitled })]));
});

it("silently treats missing, malformed, hidden, deleted, reply and nonpublic targets as a plain composer", async () => {
  const plain = (await editor("")).prefill;
  for (const id of ["", "0", "1e0", "9007199254740992", "99999999", String(reply)]) {
    expect((await editor(`?respond=${id}`)).prefill).toEqual(plain);
    expect((await editor(`?respond=${id}`)).responsePlaceHint).toBeNull();
  }
  for (const field of ["hiddenAt", "deletedAt"] as const) {
    await h.db.update(entries).set({ [field]: new Date() }).where(eq(entries.id, original));
    expect((await editor(`?respond=${original}`)).prefill).toEqual(plain);
    if (field === "hiddenAt") expect((await thread(original, "zsource")).respondWithPost).toBeNull();
    else expect(await h.outcome(() => thread(original, "zsource"))).toMatchObject({ status: 404 });
    await h.db.update(entries).set({ [field]: null }).where(eq(entries.id, original));
  }
  const [closed] = await h.db.insert(villages).values({ kind: "closed", name: "Closed" }).returning();
  await h.db.update(entries).set({ villageId: closed.id }).where(eq(entries.id, original));
  expect((await editor(`?respond=${original}`)).prefill).toEqual(plain);
  expect(await h.outcome(() => thread(original, "zsource"))).toMatchObject({ status: 404 });
  await h.db.update(entries).set({ villageId: null }).where(eq(entries.id, original));
});

it("offers the entry only to writers viewing a visible public topic", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  expect((await thread(original, "zresponder")).respondWithPost).toMatchObject({ formAction: `/t/new?respond=${original}` });
  expect((await thread(original)).respondWithPost).toBeNull();
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, h.ids.zresponder));
  expect((await thread(original, "zresponder")).respondWithPost).toBeNull();
  await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids.zresponder));
});

it("canonicalizes the response draft scope and transfers complete reply text by POST without publishing", async () => {
  const normal = await editor(`?respond=${original}`);
  expect((await editor(`?respond=0${original}`)).draftScope).toBe(normal.draftScope);
  const prepared = await editor(`?respond=${original}&village=en&intro=1`);
  const copied = new URL(prepared.newDraftAction, "http://localhost").searchParams;
  expect(Object.fromEntries(copied)).toEqual({ respond: String(original), village: "en", intro: "1", newdraft: "1" });
  expect(prepared.showIntro).toBe(true);
  const { action } = await import("~/routes/topic-new");
  const writing = "Unfinished reply.\n\n" + "Long text ".repeat(2000);
  const result = await action(h.args(h.request(`/t/new?respond=${original}`, { as: "zresponder", form: { intent: "respond", body: writing, lang: "ja", parentId: String(reply), stanceTag: "reason" } })));
  expect(result).toMatchObject({ data: { error: null, values: { title: "", body: normal.prefill!.body + writing, lang: "ja", asksStance: false } } });
});

it("keeps the source label literal without escaping plain punctuation, including departed authors", async () => {
  const title = 'Punctuation (yes)! {value} #tag | pipe ^power^ _em_ <b> &amp;';
  await h.db.update(entries).set({ title }).where(eq(entries.id, original));
  const body = (await responsePostPrefill(h.db, String(original), "en"))!.prefill.body;
  expect(body).toContain('Punctuation (yes)! {value} #tag | pipe');
  expect(body).toContain('\\^power\\^');
  expect(await markdownToPlainText(body)).toContain(title);
  expect(await parseEntryReferences(body)).toHaveLength(1);
  expect(await mentionTokens(body)).toEqual([]);
  await h.db.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL });
  await h.db.update(entries).set({ authorId: DELETED_MEMBER_ID }).where(eq(entries.id, original));
  const departed = (await responsePostPrefill(h.db, String(original), "ja"))!.prefill.body;
  expect(departed).not.toContain(DELETED_MEMBER_HANDLE);
  expect(await parseEntryReferences(departed)).toHaveLength(1);
  expect(await markdownToPlainText(departed)).toContain(title);
  expect(departed).not.toContain("@?");
  await h.db.update(entries).set({ authorId: h.ids.zsource }).where(eq(entries.id, original));
  await h.db.update(entries).set({ title: sourceTitle }).where(eq(entries.id, original));
});

it("defaults to a writable shared source village, honors explicit destinations and preserves personal defaults otherwise", async () => {
  vi.stubEnv("VILLAGES", "1");
  await ensureLanguageVillages(h.db);
  expect((await editor(`?respond=${original}`)).responsePlaceHint).toBeTruthy();
  expect((await editor("?respond=99999999")).responsePlaceHint).toBeNull();
  const en = (await languageVillage(h.db, "en"))!;
  await h.db.update(entries).set({ villageId: en.id }).where(eq(entries.id, original));
  // Reading an open village does not join it.
  const beforeJoining = (await editor("")).posting!;
  expect((await editor(`?respond=${original}`)).posting?.selected).toBe(beforeJoining.selected);
  expect((await editor(`?respond=${original}`)).posting?.choices.some(choice => choice.slug === "en")).toBe(false);
  expect(await h.db.select().from(villageMembers).where(and(eq(villageMembers.userId, h.ids.zresponder), eq(villageMembers.villageId, en.id)))).toEqual([]);
  await enrollInVillage(h.db, h.ids.zresponder, en.id);
  const usual = (await editor("")).posting!;
  const response = (await editor(`?respond=${original}`)).posting!;
  expect(response.selected).toBe("en");
  expect(response.explicit).toBe(true);
  expect((await editor("")).posting?.selected).toBe(usual.selected);
  expect((await editor(`?respond=${original}&village=${encodeURIComponent(usual.selected)}`)).posting?.selected).toBe(usual.selected);
  expect(response.choices[0].slug).toBe("en");
  expect(response.choices.filter(choice => choice.slug === "en")).toHaveLength(1);
  const { action } = await import("~/routes/topic-new");
  const transferred = await action(h.args(h.request(`/t/new?respond=${original}`, { as: "zresponder", form: { intent: "respond", body: "An unfinished reply", lang: "en" } })));
  expect(transferred).toMatchObject({ data: { values: { village: undefined, villageExplicit: undefined } } });
  const posted = await h.outcome(() => action(h.args(h.request(`/t/new?respond=${original}`, { as: "zresponder", form: {
    lang: "en", body: "Response in the shared source village", village: response.selected, villageExplicit: "1", villageDisplayed: response.selected,
  } }))));
  const postedId = Number(posted.location?.match(/^\/t\/(\d+)/)?.[1]);
  expect((await h.db.select().from(entries).where(eq(entries.id, postedId)))[0]?.villageId).toBe(en.id);
  const [invited] = await h.db.insert(villages).values({ kind: "invite_public", name: "Shared source", slug: "response-shared" }).returning();
  await h.db.insert(villageMembers).values({ villageId: invited.id, userId: h.ids.zresponder });
  await h.db.update(entries).set({ villageId: invited.id }).where(eq(entries.id, original));
  expect((await editor(`?respond=${original}`)).posting?.selected).toBe(invited.slug);
  await h.db.update(entries).set({ villageId: en.id }).where(eq(entries.id, original));
  await setDefaultVillage(h.db, h.ids.zresponder, "en");
  const same = (await editor(`?respond=${original}`)).posting!;
  expect(same.selected).toBe("en");
  expect(same.choices.filter(choice => choice.slug === "en")).toHaveLength(1);
  const [personal] = await h.db.select().from(villages).where(and(eq(villages.kind, "personal"), eq(villages.ownerId, h.ids.zsource)));
  await h.db.update(entries).set({ villageId: personal.id }).where(eq(entries.id, original));
  expect((await editor(`?respond=${original}`)).posting?.choices.some(choice => choice.slug === "@zsource")).toBe(false);
  expect((await editor(`?respond=${original}`)).posting?.selected).toBe("en");
  await h.db.update(entries).set({ villageId: (await h.db.select().from(villages).where(and(eq(villages.kind, "personal"), eq(villages.ownerId, h.ids.zresponder))))[0].id }).where(eq(entries.id, original));
  expect((await editor(`?respond=${original}`)).posting?.selected).toBe("en");
  await h.db.update(entries).set({ villageId: null }).where(eq(entries.id, original));
  expect((await editor(`?respond=${original}`)).posting?.selected).toBe("en");
});
