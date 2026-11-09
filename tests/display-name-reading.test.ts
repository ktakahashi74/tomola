import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createReply, createTopic, listTopics } from "~/lib/entries.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { updateDisplayNames } from "~/lib/display-names.server";
import { profiles, entries, villages, villageMembers, translations } from "~/lib/db/schema";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { buildListMarkdown } from "~/lib/md/lists.server";
import { buildChangesMarkdown } from "~/lib/md/changes.server";
import { loadFeedItems } from "~/lib/feeds.server";
import { acceptChatConsent, chatPage, chatChanges, mutateChat } from "~/lib/village-chat.server";
import { handlePublicMcpRequest } from "~/lib/mcp/server.server";
import { setupRouteHarness, BASE, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";

let h: RouteHarness, topicId: number, replyId: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("name_ja", { homeArea: "ja" });
  await h.signIn("name_en", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("name_reader", { homeArea: "en" });
  await updateDisplayNames(h.db, h.ids.name_ja, "光の書き手", "Light Writer");
  await updateDisplayNames(h.db, h.ids.name_en, "River Writer", "R. Writer");
  const topic = await createTopic(h.db, h.ids.name_ja, { title: "Name test article", body: "表示名の記事", lang: "ja" });
  if (!topic.ok) throw Error(topic.error); topicId = topic.id;
  const reply = await createReply(h.db, h.ids.name_en, topicId, { body: "Name test reply", lang: "en" });
  if (!reply.ok) throw Error(reply.error); replyId = reply.id;
});
afterAll(() => h.restore());

it("resolves supplementary Han names in loaders while keeping list rows compact", async () => {
  await h.signIn("name_han", { homeArea: "ja" });
  await updateDisplayNames(h.db, h.ids.name_han, "山田太郎", "Taro Yamada");
  const topic = await createTopic(h.db, h.ids.name_han, { title: "Han author fixture", body: "漢字の名前の記事。", lang: "ja" }, { now: new Date("2020-01-01") });
  if (!topic.ok) throw Error(topic.error);
  const reply = await createReply(h.db, h.ids.name_han, topic.id, { body: "漢字の名前の返信。", lang: "ja" }, { now: new Date("2020-01-02") });
  if (!reply.ok) throw Error(reply.error);
  const route = await import("~/routes/topic");
  const member = await import("~/routes/member-page");
  for (const locale of ["zh-Hans", "zh-Hant", "ja", "ko"] as const) {
    setTestLocale(locale);
    const latin = locale.startsWith("zh-") ? "Taro Yamada" : null;
    const name = locale === "ko" ? "Taro Yamada" : "山田太郎";
    const loaded = await route.loader(h.args(h.request(`/t/${topic.id}`, { as: "name_reader" }), { id: String(topic.id) })) as any;
    for (const entry of [loaded.topic, ...loaded.replies]) expect(entry).toMatchObject({ authorName: name, authorNameLatin: latin });
    const page = await member.loader(h.args(h.request("/u/name_han", { as: "name_reader" }), { handle: "name_han" })) as any;
    expect(page).toMatchObject({ name, nameLatin: latin });
    const { topics } = await listTopics(h.db, { kind: "all" }, { page: 1 });
    const items = await toTopicItems(h.db, topics, { readLangs: [], displayLang: "en" });
    expect(items.find(item => item.id === topic.id)).toMatchObject({ authorName: name });
    expect(items.find(item => item.id === topic.id)).not.toHaveProperty("authorNameLatin");
  }
});

it("chooses names for bylines, replies, member pages and list rows by screen locale", async () => {
  // A saved reading preference is deliberately different from the screen language.
  await h.db.update(profiles).set({ displayLang: "en" }).where(eq(profiles.userId, h.ids.name_reader));
  for (const locale of ["ja", "en"] as const) {
    setTestLocale(locale);
    const topic = await import("~/routes/topic");
    const loaded = await topic.loader(h.args(h.request(`/t/${topicId}`, { as: "name_reader" }), { id: String(topicId) })) as any;
    expect(loaded.topic.authorName).toBe(locale === "ja" ? "光の書き手" : "Light Writer");
    expect(loaded.replies[0].authorName).toBe(locale === "en" ? "River Writer" : "R. Writer");
    const member = await import("~/routes/member-page");
    const page = await member.loader(h.args(h.request("/u/name_ja", { as: "name_reader" }), { handle: "name_ja" })) as any;
    expect(page).toMatchObject({ name: locale === "ja" ? "光の書き手" : "Light Writer", handle: "name_ja" });
    const englishPage = await member.loader(h.args(h.request("/u/name_en", { as: "name_reader" }), { handle: "name_en" })) as any;
    expect(englishPage).toMatchObject({ name: locale === "en" ? "River Writer" : "R. Writer", handle: "name_en" });
    const { topics } = await listTopics(h.db, { kind: "all" }, { page: 1 });
    const items = await toTopicItems(h.db, topics, { readLangs: [], displayLang: "en" });
    expect(items.find(item => item.id === topicId)?.authorName).toBe(locale === "ja" ? "光の書き手" : "Light Writer");
    await h.db.update(entries).set({ authorId: h.ids.name_en }).where(eq(entries.id, topicId));
    await h.db.update(entries).set({ authorId: h.ids.name_ja }).where(eq(entries.id, replyId));
    try {
      const reversed = await topic.loader(h.args(h.request(`/t/${topicId}`, { as: "name_reader" }), { id: String(topicId) })) as any;
      expect(reversed.topic.authorName).toBe(locale === "en" ? "River Writer" : "R. Writer");
      expect(reversed.replies[0].authorName).toBe(locale === "ja" ? "光の書き手" : "Light Writer");
    } finally {
      await h.db.update(entries).set({ authorId: h.ids.name_ja }).where(eq(entries.id, topicId));
      await h.db.update(entries).set({ authorId: h.ids.name_en }).where(eq(entries.id, replyId));
    }
  }
});

it("uses the feed language and page language for RSS and shared previews", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  for (const locale of ["ja", "en"] as const) {
    setTestLocale(locale);
    expect((await loadFeedItems(h.db, { kind: "all" }, locale))[0].creator).toBe(locale === "ja" ? "光の書き手" : "Light Writer");
    const route = await import("~/routes/topic");
    const loaded = await route.loader(h.args(h.request(`/t/${topicId}?lang=${locale}`), { id: String(topicId) })) as any;
    const author = loaded.share.lang === "ja" ? "光の書き手" : "Light Writer";
    expect(loaded.share.author).toBe(author);
    const tags = route.meta({ loaderData: loaded, location: { pathname: `/t/${topicId}`, search: `?lang=${locale}` }, matches: [{ id: "root", loaderData: { publicReading: true, siteOrigin: BASE } }] } as never) as any[];
    expect(tags).toContainEqual({ property: "article:author", content: author });
  }
  vi.unstubAllEnvs();
});

it("aligns the shared author with a translated preview even when the interface language differs", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  setTestLocale("ja");
  const [topic] = await h.db.select().from(entries).where(eq(entries.id, topicId));
  // A preview uses a translation only when both the title and the body have one.
  await h.db.insert(translations).values([
    { entryId: topicId, field: "title", lang: "en", kind: "primary", text: "English preview title", engine: "fake", model: "fake", sourceHash: topic.sourceHash },
    { entryId: topicId, field: "body", lang: "en", kind: "primary", text: "English preview text.", engine: "fake", model: "fake", sourceHash: topic.sourceHash },
  ]);
  const route = await import("~/routes/topic");
  const loaded = await route.loader(h.args(h.request(`/t/${topicId}?lang=en&tr=${topicId}`), { id: String(topicId) })) as any;
  expect(loaded.share).toMatchObject({ lang: "en", author: "Light Writer", description: "English preview text." });
  const tags = route.meta({ loaderData: loaded, location: { pathname: `/t/${topicId}`, search: "?lang=en" }, matches: [{ id: "root", loaderData: { publicReading: true, siteOrigin: BASE } }] } as never) as any[];
  expect(tags).toContainEqual({ property: "article:author", content: "Light Writer" });
  expect(tags.find(tag => tag.property === "og:locale")?.content).toMatch(/^en(?:_|$)/);
  vi.unstubAllEnvs();
});

it("emits both forms with handles in Markdown, list and changes APIs, including MCP", async () => {
  for (const locale of ["en", "ja"] as const) {
    setTestLocale(locale);
    const docs = [
      await buildThreadMarkdown(h.db, topicId, { page: 1, lang: locale, sentences: false, k: null }),
      await buildListMarkdown(h.db, null, { kind: "latest" }, { page: 1, lang: locale, k: null }),
      await buildChangesMarkdown(h.db, { since: null, k: null }),
    ];
    for (const doc of docs) {
      expect(doc).toContain("@name_ja"); expect(doc).toContain("光の書き手"); expect(doc).toContain("Light Writer");
      expect(doc).toContain("display_name:"); expect(doc).toContain("display_name_latin:");
    }
  }
  vi.stubEnv("PUBLIC_READING", "1");
  const request = new Request(`${BASE}/mcp/public`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_thread", arguments: { id: topicId } } }) });
  const res = await handlePublicMcpRequest(request, { db: h.db, baseURL: BASE });
  const text = await res.text();
  expect(res.status).toBe(200); expect(text).toContain("Light Writer"); expect(text).toContain("光の書き手");
  vi.unstubAllEnvs();
});

it("withholds names along with hidden reply content in machine reads", async () => {
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, replyId));
  const doc = await buildThreadMarkdown(h.db, topicId, { page: 1, lang: "en", sentences: false, k: null });
  expect(doc).not.toContain("River Writer"); expect(doc).not.toContain("R. Writer");
});

it("chooses chat bylines on both the initial page and later message windows", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const [village] = await h.db.insert(villages).values({ slug: "name-chat", name: "Name chat", kind: "open" }).returning();
  await h.db.insert(villageMembers).values([{ villageId: village.id, userId: h.ids.name_ja, role: "owner" }, { villageId: village.id, userId: h.ids.name_reader }]);
  await acceptChatConsent(h.db, h.ids.name_ja, "name-chat"); await acceptChatConsent(h.db, h.ids.name_reader, "name-chat");
  await mutateChat(h.db, h.ids.name_ja, "name-chat", "send", { body: "光の書き手からの発言" });
  for (const locale of ["en", "ja"] as const) {
    setTestLocale(locale);
    const initial = await chatPage(h.db, h.ids.name_reader, "name-chat");
    if (!initial || initial.consentRequired) throw Error("Chat fixture requires consent");
    const changes = await chatChanges(h.db, h.ids.name_reader, "name-chat", { since: 0 });
    for (const messages of [initial.messages, changes.messages]) expect(messages[0]).toMatchObject({ author: "name_ja", authorName: locale === "ja" ? "光の書き手" : "Light Writer" });
  }
  vi.unstubAllEnvs();
});
