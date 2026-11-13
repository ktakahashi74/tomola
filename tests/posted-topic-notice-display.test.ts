import { createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import Notice from "~/components/posted-topic-notice-content";
import { languageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";
import { jsonMessages } from "./helpers/messages-json";
import { renderInRouter } from "./helpers/render-in-router";
import { setTestMessages } from "./stubs/paraglide-messages";
import { setTestLocale } from "./stubs/paraglide-runtime";

beforeAll(() => setTestMessages(jsonMessages()));
afterAll(() => setTestMessages());
afterEach(() => setTestLocale("en"));

it.each(["en", "ja"] as const)("names the destination and publication language in %s, retaining feedback without villages", async language => {
  setTestLocale(language);
  const label = language === "ja" ? "英語" : "English";
  expect(languageLabel("en")).toBe(label);
  const render = (place?: string) => renderInRouter(() => createElement(Notice, { topicId: 1, lang: "en", place, firstPost: false, initial: [], editHref: "/t/1/edit" }));
  for (const place of [m.village_personal(), "Community garden"]) {
    expect(await render(place)).toContain(m.posted_topic_public({ place, lang: label }));
  }
  expect(await render()).toContain(m.posted_topic_public_no_place({ lang: label }));
});

it.each([false, true])("renders completed source notices immediately with checking=%s", async checking => {
  const html = await renderInRouter(() => createElement(Notice, { topicId: 1, lang: "en", firstPost: false, initial: [], sourceStatus: { checking, mismatch: true, untranslatable: true }, editHref: "/t/1/edit" }));
  expect(html).toContain(m.posted_language_mismatch({ lang: languageLabel("en") }));
  expect(html).toContain(m.posted_untranslatable());
});
