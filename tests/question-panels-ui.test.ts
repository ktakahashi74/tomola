import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectionsPanel } from "~/components/objections-panel";
import TopicObjections from "~/routes/topic-objections";
import { RepliesFilter, StanceTagSelect } from "~/components/stance-tag";
import type { ObjectionPanel } from "~/lib/objections.server";
import { readReadingRequest, readingPage } from "~/lib/reading-page";
import { m } from "~/paraglide/messages.js";
import { escapeRegex, messageMarkup } from "./helpers/message-markup";
import { renderInRouter } from "./helpers/render-in-router";
import { setTestLocale } from "./stubs/paraglide-runtime";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => setTestLocale("en"));

const empty: ObjectionPanel = { alternatives: [], objections: [] };
const renderPanel = (panel: ObjectionPanel, reader = false) => renderInRouter(() => createElement(ObjectionsPanel, { questionId: 12, panel, langParam: "en", reader }));

describe("empty and populated objection panels", () => {
  it.each(["en", "ja"] as const)("folds an empty panel without JavaScript and offers both writing entries in %s", async (locale) => {
    setTestLocale(locale);
    const html = await renderPanel(empty);
    expect(html).toMatch(new RegExp(`<details\\b(?![^>]*\\bopen)[^>]*><summary[^>]*>${escapeRegex(messageMarkup(m.objections_title()))}</summary>`));
    expect(html).toContain(messageMarkup(m.objections_help()));
    expect(html).toContain('href="/t/12?write=objection#reply"');
    expect(html).toContain('href="/t/new?asks_stance=1&amp;alt_of=12"');
    expect(html).not.toContain(messageMarkup(m.objections_none()));
    expect(html).not.toContain("<h3");
  });

  it("keeps writing and member-page links out of the public reader's empty panel", async () => {
    const html = await renderPanel(empty, true);
    expect(html).toContain(messageMarkup(m.objections_help()));
    expect(html).not.toContain("<a ");
  });

  const createdAt = new Date("2026-10-08T00:00:00Z");
  const populated: Record<string, ObjectionPanel> = {
    alternative: { alternatives: [{ id: 13, lang: "en", authorHandle: "writer", createdAt, title: { text: "Another framing", lang: "en", kind: null, engine: null, fallback: false, stale: false, pending: false, fromBody: false } }], objections: [] },
    objection: { alternatives: [], objections: [{ id: 14, threadId: 12, lang: "en", authorHandle: "writer", createdAt, excerpt: "An objection", location: "/t/12#c-14" }] },
  };
  it.each(Object.entries({ empty, ...populated }))("uses the appropriate explanation on the full-list page with %s", async (_, panel) => {
    const request = new Request("https://fixture.invalid/t/12/objections");
    const chunk = <T extends { createdAt: Date; id: number }>(topics: T[], param: string) => ({
      topics, list: readingPage(topics, readReadingRequest(request, "created", 1, param, 50, "page"), row => ({ order: "created", keys: [row.createdAt.toISOString(), row.id] }), false),
    });
    const html = await renderInRouter(() => createElement(TopicObjections, { loaderData: {
      id: 12, title: { text: "Question", lang: "en" }, ...panel, hasNext: false, page: 1, langParam: null, reader: false,
      alternativesList: chunk(panel.alternatives, "list"), objectionsList: chunk(panel.objections, "vlist"),
    } } as never), "/t/12/objections");
    const hasItems = panel.alternatives.length > 0 || panel.objections.length > 0;
    expect(html).toContain(`>${messageMarkup(hasItems ? m.objections_neutrality() : m.objections_help())}</p>`);
    expect(html).not.toContain(`>${messageMarkup(hasItems ? m.objections_help() : m.objections_neutrality())}</p>`);
  });

  it.each(Object.entries(populated))("keeps the panel open when an %s is present", async (_, panel) => {
    const html = await renderPanel(panel);
    expect(html).not.toContain("<details");
    expect(html).toContain(messageMarkup(m.objections_neutrality()));
    expect(html).not.toContain(messageMarkup(m.objections_help()));
    expect(html).toContain("<h2");
    expect(html).toContain('href="/t/12/objections?lang=en"');
    expect(html).toContain('href="/u/writer"');
  });
});

it("gives each reply selector its own explanation", async () => {
  const html = await renderInRouter(() => createElement("div", null,
    createElement(StanceTagSelect, { defaultValue: "agree" }),
    createElement(StanceTagSelect, { defaultValue: "disagree" })));
  const descriptions = [...html.matchAll(/aria-describedby="([^"]+-help)"/g)].map(match => match[1]);
  expect(descriptions).toHaveLength(2);
  expect(new Set(descriptions).size).toBe(2);
  for (const id of descriptions) expect(html).toContain(`id="${id}"`);
  expect(html).toContain(messageMarkup(m.stance_tag_help()));
});

it.each(["en", "ja"] as const)("names the replies filter for assistive technology only, with no visible prefix, in %s", async locale => {
  setTestLocale(locale);
  const html = await renderInRouter(() => createElement(RepliesFilter, { current: "agree" }));
  expect(html).toContain(`aria-label="${messageMarkup(m.replies_filter_label())}"`);
  expect(html).not.toContain(messageMarkup(m.filter_prefix()));
});
