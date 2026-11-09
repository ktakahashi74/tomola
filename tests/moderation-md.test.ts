import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { entries, translations } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { createReply, createTopic } from "~/lib/entries.server";
import { hideEntry, unhideEntry } from "~/lib/moderation.server";
import { createApiToken } from "~/lib/tokens.server";
import { setVote } from "~/lib/votes.server";
import { getMd, parseBlocks, parseThreadBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Hidden entries in Markdown, lists, feeds, and manifests expose no body, title, or author; use a hidden=true placeholder.
// Hidden Markdown is unavailable even to the author or moderator; only the UI can show it.
let h: RouteHarness;
const OP = { operator: true, langs: [] };
const SECRET = "SECRET-BODY-OF-THE-HIDDEN-POST";
const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n));

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("taro", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("opal", { homeArea: "ja", readLangs: ["ja"] });
});
afterAll(() => h.restore());

const hide = (entryId: number, now: Date) => hideEntry(h.db, { id: h.ids.opal, scope: OP }, { entryId, reason: "spam", note: "spam" }, { now });
const unhide = (entryId: number, now: Date) => unhideEntry(h.db, { id: h.ids.opal, scope: OP }, { entryId, reason: "other" }, { now });

async function thread(title: string) {
  const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title, body: "話題の本文" }, { now: at(0) });
  if (!topic.ok) throw new Error("topic failed");
  const a = await createReply(h.db, h.ids.taro, topic.id, { lang: "ja", body: SECRET }, { now: at(1) });
  const b = await createReply(h.db, h.ids.hana, topic.id, { lang: "ja", body: "残る返信", parentId: a.ok ? a.id : undefined }, { now: at(2) });
  if (!a.ok || !b.ok) throw new Error("reply failed");
  return { topic: topic.id, a: a.id, b: b.id };
}

describe("the thread twin", () => {
  it("keeps the place of a hidden reply with hidden: true and gives no body, author, translation or votes, to anybody", async () => {
    const t = await thread("非表示の返信");
    await h.db.insert(translations).values({ entryId: t.a, field: "body", lang: "en", kind: "primary", text: "TRANSLATED-SECRET", engine: "fake", model: "m", sourceHash: (await h.db.select({ s: entries.sourceHash }).from(entries).where(eq(entries.id, t.a)))[0].s });
    await setVote(h.db, h.ids.hana, t.a, true);
    await hide(t.a, at(10));
    for (const as of ["hana", "taro", "opal"]) {
      const doc = await (await getMd(h, `/t/${t.topic}.md?lang=en&sentences=1`, { as })).text();
      expect(doc, as).not.toContain(SECRET);
      expect(doc, as).not.toContain("TRANSLATED-SECRET");
      const blocks = parseThreadBlocks(doc);
      expect(blocks.map((x) => x.fm.id ?? x.fm.type), as).toEqual([`p-${t.topic}`, `c-${t.a}`, `c-${t.b}`, "index"]);
      expect(blocks[1].fm, as).toEqual({ type: "comment", id: `c-${t.a}`, thread: `p-${t.topic}`, reply_to: `p-${t.topic}`, hidden: true, content_trust: "untrusted_user_content" });
      expect(blocks[1].body).toBe("");
      // An adjacent reply remains normal and retains the hidden parent's ID.
      expect(blocks[2].fm).toMatchObject({ id: `c-${t.b}`, reply_to: `c-${t.a}`, author: "@hana" });
    }
    await unhide(t.a, at(20));
    const back = await (await getMd(h, `/t/${t.topic}.md`, { as: "taro" })).text();
    expect(back).toContain(SECRET);
  });

  it("makes a hidden topic a placeholder (no title, body or author) and still lists its replies", async () => {
    const t = await thread("非表示の話題-TITLE");
    await hide(t.topic, at(10));
    const doc = await (await getMd(h, `/t/${t.topic}.md`, { as: "taro" })).text();
    expect(doc).not.toContain("非表示の話題-TITLE");
    expect(doc).not.toContain("話題の本文");
    // A hidden topic has no overview: the placeholder is the first block.
    const blocks = parseThreadBlocks(doc, "none");
    expect(blocks[0].fm).toMatchObject({ type: "post", id: `p-${t.topic}`, thread: `p-${t.topic}`, hidden: true });
    expect(blocks[0].fm).not.toHaveProperty("title");
    expect(blocks[0].fm).not.toHaveProperty("author");
    // The first block contains the fixed warning.
    expect(doc.split("\n").slice(0, 2)[1]).toMatch(/^# tomola Markdown twin\./);
    expect(blocks.slice(1).map((b) => b.fm.id ?? b.fm.type)).toEqual([`c-${t.a}`, `c-${t.b}`, "index"]);
    expect(blocks[1].fm).toMatchObject({ author: "@taro" });
  });

  it("numbers the canonical page of a reply like the screen: hidden and deleted replies count in both", async () => {
    const t = await thread("ページ");
    const rows = await h.db
      .insert(entries)
      .values(Array.from({ length: 105 }, (_, i) => ({ kind: "reply", threadId: t.topic, authorId: h.ids.taro, lang: "ja", body: `x${i}`, createdAt: at(100 + i), updatedAt: at(100 + i) })))
      .returning({ id: entries.id });
    await hide(rows[0].id, at(300));
    const page2 = parseThreadBlocks(await (await getMd(h, `/t/${t.topic}.md?page=2`, { as: "hana" })).text());
    // Hidden replies count toward the 100; with a, b, and 105 others, page 2 starts at global position 101.
    expect(page2.filter((b) => b.fm.type === "comment").map((b) => new URL(b.fm.canonical as string).searchParams.get("page"))).toEqual(Array(page2.length - 1).fill("2"));
    const page1 = parseThreadBlocks(await (await getMd(h, `/t/${t.topic}.md`, { as: "hana" })).text());
    expect(page1.find((b) => b.fm.id === `c-${rows[0].id}`)!.fm).toMatchObject({ hidden: true });
    expect(page1.find((b) => b.fm.id === `c-${t.b}`)!.fm.canonical).toBe(`http://localhost:5173/t/${t.topic}#c-${t.b}`);
  });
});

describe("the lists, the change feed and the manifest", () => {
  it("leaves a hidden topic out of the list twins, and the list of the author too", async () => {
    const t = await thread("一覧の話題-LISTED");
    const items = async (path: string, as: string) => {
      const blocks = parseBlocks(await (await getMd(h, path, { as })).text());
      return parse(blocks[0].body, { schema: "core" }) as Array<{ id: string }>;
    };
    expect((await items("/latest.md", "hana")).some((i) => i.id === `p-${t.topic}`)).toBe(true);
    await hide(t.topic, at(10));
    for (const path of ["/latest.md", "/a/ja.md"]) {
      for (const as of ["hana", "taro", "opal"]) expect((await items(path, as)).some((i) => i.id === `p-${t.topic}`), `${path} ${as}`).toBe(false);
    }
    // Home has headings for multiple lists; check the strings.
    for (const as of ["hana", "taro", "opal"]) expect(await (await getMd(h, "/home.md", { as })).text(), as).not.toContain("一覧の話題-LISTED");
    await unhide(t.topic, at(20));
    expect((await items("/latest.md", "taro")).some((i) => i.id === `p-${t.topic}`)).toBe(true);
  });

  it("reports hide as change: hidden without title or author, and a show-again as edited with the content", async () => {
    const t = await thread("フィードの話題-FEED");
    const feed = async (since: string) => {
      const md = await (await (await import("~/routes/changes-md")).loader(h.args(h.request(`/changes.md?since=${encodeURIComponent(since)}`, { as: "hana" })))).text();
      return { md, list: parse(parseBlocks(md)[0].body, { schema: "core" }) as Array<Record<string, unknown>> };
    };
    await hide(t.a, at(50));
    const hidden = await feed(at(45).toISOString());
    const ofThread = (list: Array<Record<string, unknown>>) => list.filter((i) => i.thread === `p-${t.topic}`);
    expect(ofThread(hidden.list)).toEqual([
      { change: "hidden", id: `c-${t.a}`, thread: `p-${t.topic}`, changed_at: at(50).toISOString(), md: `http://localhost:5173/t/${t.topic}.md`, canonical: `http://localhost:5173/t/${t.topic}` },
    ]);
    expect(hidden.md).not.toContain(SECRET);
    // Created after since but hidden: emit hidden.
    const since = await feed(at(0).toISOString());
    expect(ofThread(since.list).filter((i) => i.id === `c-${t.a}`).map((i) => i.change)).toEqual(["hidden"]);
    await unhide(t.a, at(60));
    const shown = await feed(at(55).toISOString());
    expect(ofThread(shown.list)).toMatchObject([{ change: "edited", id: `c-${t.a}`, changed_at: at(60).toISOString(), lang: "ja", author: "@taro" }]);
  });

  it("puts 'hidden' in the manifest's content_hash and moves updated_at; showing the post again restores the hash", async () => {
    const t = await thread("マニフェストの話題");
    const entry = async () => {
      const res = await (await (await import("~/routes/manifest")).loader(h.args(h.request("/manifest.json", { as: "hana" })))).json();
      return res.topics.find((x: { id: string }) => x.id === `p-${t.topic}`) as { content_hash: string; updated_at: string } | undefined;
    };
    const before = (await entry())!;
    await hide(t.a, at(70));
    const hiddenReply = (await entry())!;
    expect(hiddenReply.content_hash).not.toBe(before.content_hash);
    expect(hiddenReply.updated_at).toBe(at(70).toISOString());
    await unhide(t.a, at(80));
    const back = (await entry())!;
    expect(back.content_hash).toBe(before.content_hash);
    expect(back.updated_at).toBe(at(80).toISOString());
    // Hidden entries remain in the manifest; their hash changes to the placeholder Markdown.
    await hide(t.topic, at(90));
    const hiddenTopic = (await entry())!;
    expect(hiddenTopic).toBeDefined();
    expect(hiddenTopic.content_hash).not.toBe(before.content_hash);
    const token = await createApiToken(h.db, h.ids.hana, { name: "r", kind: "read" });
    if (!token.ok) throw new Error(token.error);
  });

  it("documents the hidden placeholder in /llms.txt", async () => {
    const { llmsTxt } = await import("~/lib/api/guides.server");
    const text = llmsTxt();
    expect(text).toContain("hidden: true");
    expect(text).toContain("change: hidden");
    expect(text).toContain('"hidden" for a post hidden by moderation');
  });
});
