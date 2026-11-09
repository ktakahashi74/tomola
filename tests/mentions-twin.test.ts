import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReply, createTopic } from "~/lib/entries.server";
import { getMd, parseThreadBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The Markdown twin shows a mention as the text that was written: not as a link, not as HTML, and nothing about mentions in the frontmatter.
let h: RouteHarness;
let topicId: number;

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("ben", { homeArea: "en", readLangs: ["en", "ja"] });
  const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "呼びかけ", body: "@ben さん、＠Ben さん。`@ben` と [@ben](https://example.com)。\n\n> @ben 引用" });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;
  const reply = await createReply(h.db, h.ids.ben, topicId, { lang: "en", body: "Thanks @hana!" });
  if (!reply.ok) throw new Error("reply failed");
});
afterAll(() => h.restore());

describe("the Markdown twin of a thread with mentions", () => {
  it("has the body as written, without HTML or a link for the mention, and no mention information in the frontmatter", async () => {
    const res = await getMd(h, `/t/${topicId}.md`, { as: "ben" });
    expect(res.status).toBe(200);
    const text = await res.text();
    const blocks = parseThreadBlocks(text);
    expect(blocks[0].body).toContain("@ben さん、＠Ben さん。`@ben` と [@ben](https://example.com)。");
    expect(blocks[0].body).toContain("> @ben 引用");
    expect(blocks[1].body).toBe("Thanks @hana!");
    expect(text).not.toContain("class=\"mention\"");
    expect(text).not.toContain("<span");
    expect(text).not.toMatch(/\]\(\/u\/|mention/i);
    // Nothing in any frontmatter names mentions (a member who registers later would change the file without the post changing).
    for (const block of blocks) expect(Object.keys(block.fm).filter((k) => /mention/i.test(k))).toEqual([]);
  });

  it("is the same with a translation: the translation's text is as stored, with the mention as plain text", async () => {
    const { entries, translations } = await import("~/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await h.db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
    await h.db.insert(translations).values({ entryId: topicId, field: "body", lang: "en", kind: "primary", text: "Dear @ben, ＠Ben.", engine: "fake", model: "fake-1", sourceHash: row.hash });
    const text = await (await getMd(h, `/t/${topicId}.md?lang=en`, { as: "ben" })).text();
    expect(text).toContain("Dear @ben, ＠Ben.");
    expect(text).not.toContain("<span");
  });
});
