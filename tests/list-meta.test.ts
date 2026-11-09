import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ListMeta } from "~/components/list-meta";
import { TopicList } from "~/components/topic-list";
import type { TopicItem } from "~/lib/topic-list.server";
import { renderInRouter } from "./helpers/render-in-router";
import { jsonMessages } from "./helpers/messages-json";
import { setTestMessages } from "./stubs/paraglide-messages";

beforeEach(() => setTestMessages(jsonMessages()));
afterEach(() => setTestMessages());

it("omits absent items and keeps word boundaries for reading and copying", () => {
  const html = renderToStaticMarkup(createElement(ListMeta, { items: [
    { key: "language", content: "Japanese" }, false,
    { key: "time", content: createElement("time", null, "2 hours ago") }, null,
    { key: "translation", content: "AI translation", badge: true }, undefined,
  ] }));
  expect(html.replace(/<[^>]+>/g, "")).toBe("Japanese 2 hours ago AI translation");
  expect((html.match(/class="sr-only"> <\/span>/g) ?? []).length).toBe(2);
  expect(renderToStaticMarkup(createElement(ListMeta, { items: [] })).replace(/<[^>]+>/g, "")).toBe("");
});

const base: TopicItem = {
  id: 1, lang: "ja", displayLang: "en", authorHandle: "writer", replyCount: 0,
  createdAt: "2026-10-01T12:34:00Z", lastActivityAt: "2026-10-02T12:34:00Z", latestReply: null,
  hidden: false, asksStance: false, insightful: { total: 0, langs: 0 },
  title: { text: "Title", lang: "en", kind: null, engine: null, fallback: false, stale: false, pending: false, fromBody: false },
};

for (const rich of [false, true]) for (const badges of [false, true]) {
  it(`separates visible topic items structurally (optional items ${rich}, badges ${badges})`, async () => {
    const topic: TopicItem = {
      ...base, asksStance: badges, hidden: badges,
      ...(rich ? {
        replyCount: 2, latestReply: { id: 4, page: 2 }, newReplies: { count: 1, href: "/t/1#c-4" },
        village: { slug: "sample", name: "Sample village" }, insightful: { total: 3, langs: 2 },
        title: { ...base.title, kind: "primary" as const, engine: "fake", pending: true, unavailable: true },
      } : {}),
    };
    const html = await renderInRouter(() => createElement(TopicList, { topics: [topic], compactMeta: true, langParam: null, empty: "none" }));
    const row = html.split('data-list-meta="">')[1].split("</div>")[0];
    const items = [...row.matchAll(/data-meta-item="(text|badge)">([\s\S]*?)(?=<span [^>]*data-meta-item=|$)/g)];
    expect(items.length).toBe(rich ? (badges ? 10 : 8) : (badges ? 4 : 2));
    items.forEach(([markup], index) => {
      expect((markup.match(/class="sr-only"> <\/span>/g) ?? []).length).toBe(index + 1 < items.length ? 1 : 0);
    });
    expect(html).toContain(`dateTime="${base.lastActivityAt}"`);
    if (rich) {
      expect(row).toContain("Sample village");
      expect(row).toContain("3");
    }
  });
}
