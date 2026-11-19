import { notificationItem, notificationsData, replyEntry, searchData, topicData, topicEntry } from "./helpers/loader-fixtures";
import { createElement } from "react";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { setTestMessages } from "./stubs/paraglide-messages";
import { languageLabel } from "~/lib/language-label";
import { TopicList } from "~/components/topic-list";
import { ReasonsPanel, type ReasonView } from "~/components/reasons-panel";
import { ObjectionsPanel } from "~/components/objections-panel";
import type { TopicItem } from "~/lib/topic-list.server";
import type { EntryDisplay } from "~/lib/entry-display.server";
import { readingVersions } from "~/lib/reading.server";
import Topic from "~/routes/topic";
import Search from "~/routes/search";
import Notifications from "~/routes/notifications";
import { renderInRouter } from "./helpers/render-in-router";
import { routeElement } from "./helpers/route-fixtures";

beforeEach(() => setTestMessages(new Proxy({} as Record<string, (params?: Record<string, unknown>) => string>, {
    get: (_, key) => (params?: Record<string, unknown>) => key === "notification_mention"
      ? `@${params?.handle} mentioned you in "${params?.title}".`
      : String(key),
  })));
afterEach(() => setTestMessages());

const createdAt = new Date("2026-10-03T00:00:00Z");
const insightful = { total: 0, langs: 0 };
const original: EntryDisplay = { shown: "original", pending: false, translation: null };
const item = (id: number, authorHandle: string): TopicItem => ({
  createdAt: createdAt.toISOString(), lastActivityAt: createdAt.toISOString(), latestReply: null,
  id, authorHandle, lang: "ja", replyCount: 0, hidden: false, asksStance: false, insightful,
  title: { text: "A topic", lang: "en", kind: null, engine: null, fallback: false, stale: false, pending: false, fromBody: false },
});
const reason = (id: number, authorHandle: string): ReasonView => ({
  id, authorHandle, lang: "ja", own: false, location: `/t/1#c-${id}`, reviewHref: null,
  reactions: { insightful, mine: false },
  excerpt: { text: "A reason", lang: "ja", truncated: false, translation: null, pending: false },
});
const thread = (display = original) => {
  const topic = topicEntry({ authorHandle: "current_topic", display });
  const reply = replyEntry({ id: 2, authorHandle: "current_reply", display });
  return {
    ...topicData({ replies: [reply] }),
    topic,
  };
};
const hit = (id: number, authorHandle: string | null): ReturnType<typeof searchData>["hits"][number] => ({
  id, authorHandle, createdAt, kind: "topic", matchKind: "semantic", threadId: id, lang: "ja", distance: 0, href: `/t/${id}?lang=en`,
  title: { text: "A topic", lang: "en", translation: null, pending: false, fromBody: false },
  excerpt: { text: "Body", lang: "ja", translation: null, pending: false },
});

// Inspect the rendered links: the visible author name and destination must both come from the current handle.
const memberLinks = (html: string) => [...html.matchAll(/<a\b[^>]*\bhref="(\/u\/[^\"]+)"[^>]*>([^<]*)<\/a>/g)]
  .map((match) => ({ href: match[1], text: match[2] }));
const link = (handle: string) => ({ href: `/u/${handle}`, text: `@${handle}` });

describe("author names open the member page", () => {
  it("shows the row author before the original language for members and readers", async () => {
    for (const reader of [false, true]) {
      for (const fromBody of [false, true]) {
        const post = item(1, "ordered_writer");
        post.title = { ...post.title, fromBody };
        const html = await renderInRouter(() => createElement(TopicList, { topics: [post], reader, langParam: null, empty: "none" }));
        const authorPosition = html.indexOf("@ordered_writer");
        const languagePosition = html.indexOf(languageLabel("ja"));
        expect(authorPosition).toBeGreaterThanOrEqual(0);
        expect(authorPosition).toBeLessThan(languagePosition);
      }
    }
  });

  it("uses the supplied current handle on rows, including after a name change", async () => {
    for (const handle of ["before_change", "after_change"]) {
      const html = await renderInRouter(() => createElement(TopicList, { topics: [item(1, handle)], langParam: "en", empty: "none" }));
      expect(memberLinks(html)).toEqual([link(handle)]);
      expect(html).toContain(languageLabel("ja"));
    }
  });

  it("links every topic-list author and keeps the original-language label", async () => {
    const html = await renderInRouter(() => createElement(TopicList, { topics: [item(1, "first_writer"), item(2, "second_writer")], langParam: "en", empty: "none" }), "/latest?lang=en");
    expect(memberLinks(html)).toEqual([link("first_writer"), link("second_writer")]);
    expect(html).toContain(languageLabel("ja"));
  });

  it("leaves a missing-profile author placeholder as plain text", async () => {
    const html = await renderInRouter(() => createElement(TopicList, { topics: [item(1, "?")], langParam: null, empty: "none" }));
    expect(memberLinks(html)).toEqual([]);
    expect(html).toContain("@?");
  });

  it("links the byline, signature and reply authors with either displayed version", async () => {
    const translated: EntryDisplay = {
      shown: "translation", pending: false,
      translation: { lang: "en", kind: "primary", engine: "fake", model: "fake", fallback: false, stale: false, html: "<p>Translated</p>", title: null, headline: null, older: null, reportNotice: null },
    };
    for (const display of [original, translated]) {
      const html = await renderInRouter(() => routeElement(Topic, { loaderData: thread(display) }), "/t/1?lang=en");
      expect(memberLinks(html)).toEqual([link("current_topic"), link("current_topic"), link("current_reply")]);
    }
  });

  it("keeps article identity and dates in the header and signature, with controls after the body", async () => {
    for (const name of [null, "Writer Name"]) {
      const loaderData = thread();
      const source = loaderData.topic.html;
      const topic = { ...loaderData.topic, authorName: name, avatarUrl: "/avatar/fixture", canEdit: true,
        reading: readingVersions(source, "ja", original) };
      const html = await renderInRouter(() => routeElement(Topic, { loaderData: { ...loaderData, topic } }), "/t/1?lang=en");
      const header = html.slice(html.indexOf('data-reading-byline'), html.indexOf('data-reading-body'));
      const signature = html.slice(html.indexOf('data-article-signature'), html.indexOf('data-article-end'));
      expect(header).toContain("@current_topic");
      expect(header).not.toContain("/avatar/fixture");
      expect(header).not.toContain('href="/t/1/edit"');
      expect(header).toContain("October 3, 2026");
      expect(signature).toContain("@current_topic");
      if (name) { expect(header).toContain(name); expect(signature).toContain(name); }
      expect(html.indexOf('href="/t/1/edit"')).toBeGreaterThan(html.indexOf('data-article-end'));
      expect(html.indexOf('data-reading-discussion')).toBeLessThan(html.indexOf('id="replies"'));
    }
  });

  it("keeps withheld topic and reply author names out of links", async () => {
    const loaderData = topicData({ topic: { id: 1, placeholder: "hidden" }, replies: [{ id: 2, placeholder: "deleted" }] });
    const html = await renderInRouter(() => routeElement(Topic, { loaderData }), "/t/1");
    expect(memberLinks(html)).toEqual([]);
    expect(html).not.toContain("current_topic");
    expect(html).not.toContain("current_reply");
  });

  it("links search authors while retaining results without an author profile", async () => {
    const html = await renderInRouter(() => routeElement(Search, { loaderData: searchData({ q: "body", hits: [hit(1, "search_writer"), hit(2, null)] }) }), "/search?q=body&lang=en");
    expect(memberLinks(html)).toEqual([link("search_writer")]);
    expect(html).toContain('href="/t/2?lang=en"');
    expect(html).not.toContain("@null");
  });

  it("links picked reasons in all three positions", async () => {
    const html = await renderInRouter(() => createElement(ReasonsPanel, { questionId: 1, reasons: { agree: [reason(2, "agree_writer")], disagree: [reason(3, "disagree_writer")], neither: [reason(4, "neither_writer")] }, langParam: "en", readingLang: "en" }), "/t/1?lang=en");
    expect(memberLinks(html)).toEqual([link("agree_writer"), link("disagree_writer"), link("neither_writer")]);
  });

  it("links both alternative-question and objection-reply authors", async () => {
    const html = await renderInRouter(() => createElement(ObjectionsPanel, {
      questionId: 1, langParam: "en",
      panel: {
        alternatives: [{ id: 2, authorHandle: "alternative_writer", lang: "ja", title: item(2, "alternative_writer").title, createdAt }],
        objections: [{ id: 3, threadId: 1, authorHandle: "objection_writer", lang: "ja", excerpt: "An objection", location: "/t/1#c-3", createdAt }],
      },
    }), "/t/1?lang=en");
    expect(memberLinks(html)).toEqual([link("alternative_writer"), link("objection_writer")]);
  });

  it("keeps the entire notification sentence as one notification-opening link", async () => {
    const html = await renderInRouter(() => routeElement(Notifications, {
      loaderData: notificationsData({
        items: [notificationItem({ actorHandle: "notification_writer", topicTitle: "A topic", href: "/t/1#c-2" })],
      })
    }), "/notifications");
    expect(memberLinks(html)).toEqual([]);
    expect(html).toMatch(/<a\b[^>]*href="\/notifications\/1\/open"[^>]*>@notification_writer mentioned you in &quot;A topic&quot;\.<\/a>/);
  });
});
