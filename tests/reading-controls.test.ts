import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { setTestMessages } from "./stubs/paraglide-messages";
import { TopicList } from "~/components/topic-list";
import { LocalTime } from "~/components/local-time";
import { OrderSwitch } from "~/components/order-switch";
import { TopicShare } from "~/components/topic-share";
import type { TopicItem } from "~/lib/topic-list.server";
import { renderInRouter } from "./helpers/render-in-router";
import { jsonMessages } from "./helpers/messages-json";
import { setTestLocale } from "./stubs/paraglide-runtime";

beforeEach(() => setTestMessages(jsonMessages()));
afterEach(() => setTestMessages());

it("does not expose an empty share control before client activation", () => {
  expect(renderToStaticMarkup(createElement(TopicShare, { topicId: 1, readingLang: "en", originalLang: "ja" }))).toBe("");
});

it("keeps the machine timestamp and a stable UTC fallback before client activation", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  try {
    const iso = "2026-10-01T12:34:00Z";
    const html = renderToStaticMarkup(createElement(LocalTime, { iso, formatLabel: text => `Updated ${text}` }));
    expect(html).toContain(`dateTime="${iso}"`);
    // The title is a readable date in the reader's language, never the machine string.
    expect(html).not.toContain(`title="${iso}"`);
    expect(html).toContain('title="October 1, 2026 at 12:34:00 PM UTC"');
    expect(html).toContain(">Updated Oct 1</time>");
    // A clock time says which zone it is until the reader's own zone is known.
    expect(renderToStaticMarkup(createElement(LocalTime, { iso, style: "stamp" }))).toContain(">Oct 1 12:34 PM UTC</time>");
  } finally {
    vi.useRealTimers();
  }
});

it("ordering drops the one-use management disclosure while preserving other filters", async () => {
  const html = await renderInRouter(() => createElement(OrderSwitch, { order: "activity" }),
    "/v/example?manage=1&lang=ja&asks=1&page=3&membersPage=2");
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), "http://localhost"));
  expect(links).toHaveLength(3);
  for (const link of links) {
    expect(link.searchParams.has("manage")).toBe(false);
    expect(link.searchParams.has("page")).toBe(false);
    expect(link.searchParams.get("lang")).toBe("ja");
    expect(link.searchParams.get("asks")).toBe("1");
    expect(link.searchParams.get("membersPage")).toBe("2");
  }
});

it("keeps full metadata by default and concise list metadata retains counts and timestamps", async () => {
  const m = jsonMessages();
  const topic: TopicItem = {
    id: 1, lang: "en", displayLang: "en", authorHandle: "writer", replyCount: 0,
    createdAt: "2026-10-01T12:34:00Z", lastActivityAt: "2026-10-02T12:34:00Z", latestReply: null,
    hidden: false, asksStance: false, insightful: { total: 7, langs: 3 },
    title: { text: "Title", lang: "en", kind: "primary", engine: "gemini", fallback: false, stale: false, pending: false, fromBody: false },
  };
  const render = (compactMeta: boolean) => renderInRouter(() => createElement(TopicList, { topics: [topic], compactMeta, langParam: null, empty: "none" }));
  const full = await render(false);
  const concise = await render(true);
  expect(full).toContain("Gemini");
  expect(full).toContain("English");
  expect(concise).not.toContain("Gemini");
  // The plain language span is gone: the phrase "AI-translated from English" says it.
  expect(concise).not.toContain("<span>English</span>");
  // A concise row says it in one phrase: the language it was translated from, and that it is a machine translation.
  expect(concise).toContain(m.label_from_lang_machine({ lang: "English" }));
  expect(concise).toMatch(/datetime="2026-10-02T12:34:00Z"/i);
  expect(concise).toContain(m.insightful_count({ total: 7, langs: 3 }));
});

it("uses the UTC date and year for the first localized render at a year boundary", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
  vi.stubEnv("TZ", "Pacific/Auckland");
  setTestLocale("fr");
  try {
    const html = renderToStaticMarkup(createElement(LocalTime, { iso: "2026-01-01T00:30:00Z" }));
    expect(html).toContain(">1 janv.</time>");
    expect(html).toMatch(/datetime="2026-01-01T00:30:00Z"/i);
  } finally {
    setTestLocale("en");
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

it("omits a language repeated by a language list but retains it on other lists", async () => {
  const topic: TopicItem = {
    id: 2, lang: "fr", displayLang: "en", authorHandle: "writer", replyCount: 0,
    createdAt: "2026-10-01T12:34:00Z", lastActivityAt: "2026-10-02T12:34:00Z", latestReply: null,
    hidden: false, asksStance: false, insightful: { total: 0, langs: 0 },
    title: { text: "Title", lang: "en", kind: "primary", engine: "fake", fallback: false, stale: false, pending: false, fromBody: false },
  };
  const render = (showOriginalLanguage: boolean) => renderInRouter(() => createElement(TopicList, { topics: [topic], compactMeta: true, showOriginalLanguage, langParam: null, empty: "none" }));
  expect(await render(true)).toContain("French");
  expect(await render(false)).not.toContain("French");
});
