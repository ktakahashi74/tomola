import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { expect, it, vi } from "vitest";
import BodyTranslationWait from "~/components/body-translation-wait";
import { TranslatedEntry } from "~/components/translated-entry";
import { TopicList } from "~/components/topic-list";
import { ChatMessageView } from "~/components/chat-message";
import type { EntryDisplay } from "~/lib/entry-display.server";
import type { TopicItem } from "~/lib/topic-list.server";
import type { ActiveChatMessage } from "~/lib/village-chat";
import { NORMAL_WAITS, TranslationWaitContext, type TranslationWait } from "~/lib/translation-wait";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const stopped: TranslationWait = { kind: "stopped" };
const waits = (posts: TranslationWait, chat: TranslationWait = posts) => ({ posts, chat });
// Rendered markup escapes apostrophes; compare the text a reader sees.
const text = (html: string) => html.replaceAll("&#x27;", "'");
const within = (value: ReturnType<typeof waits>, node: ReactNode) => createElement(TranslationWaitContext.Provider, { value }, node);

const pendingDisplay: EntryDisplay = { shown: "original", pending: true, translation: null } as EntryDisplay;
const entry = (kind: "topic" | "reply", value = NORMAL_WAITS) => text(renderToStaticMarkup(within(value, createElement(StaticRouter, { location: "/t/5" },
  createElement(TranslatedEntry, { id: 5, kind, lang: "ja", title: kind === "topic" ? "原題" : null, html: "<p>原文の本文</p>", display: pendingDisplay, meta: createElement("div", null, "meta") })))));

it("tells a reader of a thread only that translation is unavailable when it is stopped, with no budget or date, and keeps the original readable", () => {
  for (const kind of ["topic", "reply"] as const) {
    const normal = entry(kind);
    expect(normal).toContain(m.label_pending());
    const stoppedHtml = entry(kind, waits(stopped));
    expect(stoppedHtml).toContain(m.label_no_translation());
    expect(stoppedHtml).toContain("原文の本文");
    expect(stoppedHtml).not.toContain(m.label_pending());
    expect(stoppedHtml).not.toMatch(/budget|limit|resume|setting|month/i);
  }
});

it("uses the post state for posts and leaves chat's own state alone", () => {
  expect(entry("topic", waits(NORMAL_WAITS.posts, stopped))).toContain(m.label_pending());
});

const topic: TopicItem = {
  id: 1, lang: "ja", displayLang: "en", authorHandle: "writer", replyCount: 0,
  createdAt: "2026-10-01T12:34:00Z", lastActivityAt: "2026-10-02T12:34:00Z", latestReply: null,
  hidden: false, asksStance: false, insightful: { total: 0, langs: 0 },
  title: { text: "題", lang: "ja", kind: null, engine: null, fallback: false, stale: false, pending: true, fromBody: false },
} as unknown as TopicItem;

it("shows the same on a list row", async () => {
  const row = async (value: ReturnType<typeof waits>) => text(await renderInRouter(() => within(value, createElement(TopicList, { topics: [topic], compactMeta: true, langParam: null, empty: "none" }))));
  expect(await row(NORMAL_WAITS)).toContain(m.label_pending_short());
  const stoppedRow = await row(waits(stopped));
  expect(stoppedRow).toContain(m.label_no_translation_short());
  expect(stoppedRow).not.toContain(m.label_pending_short());
});

const message = (state: "pending" | "paused"): ActiveChatMessage => ({
  id: "m1", author: "kim", own: false, lang: "ja", parts: [{ type: "text", text: "こんにちは" }], createdSeq: 1, changedSeq: 1,
  createdAt: "2026-10-01T12:34:00Z", edited: false, deleted: false, hidden: false, translation: { text: null, lang: "en", state },
});
const chat = async (state: "pending" | "paused", value: ReturnType<typeof waits>) => text(await renderInRouter(() => within(value, createElement(ChatMessageView, {
  message: message(state), ended: false, slug: "ai", originals: false, grouped: false, calendar: { timeZone: "UTC", locale: "en", now: Date.parse("2026-10-01T12:40:00Z") }, self: "me", onReport: () => {},
}))));

it("shows the general notice at once when chat translation is stopped, for waiting and for paused messages alike", async () => {
  // Waiting its turn: nothing is drawn until the short delay passes.
  expect(await chat("pending", NORMAL_WAITS)).not.toContain(m.village_chat_translation_pending());
  expect(await chat("pending", waits(NORMAL_WAITS.posts, stopped))).toContain(m.label_no_translation());
  expect(await chat("paused", NORMAL_WAITS)).toContain(m.label_no_translation());
  expect(await chat("paused", waits(stopped, NORMAL_WAITS.chat))).toContain(m.label_no_translation());
});

it("server-only rendering does not announce work that no browser has requested", async () => {
  const html = text(await renderInRouter(() => createElement(BodyTranslationWait, { entryId: 5 }), "/t/5"));
  expect(html).toContain(m.label_pending_short());
  expect(html).not.toContain(m.translation_working());
  expect(html).not.toContain(m.translation_working_accessible());
});
