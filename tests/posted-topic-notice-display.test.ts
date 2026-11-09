import { createElement } from "react";
import { expect, it, vi } from "vitest";
import Notice from "~/components/posted-topic-notice-content";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";

const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("~/paraglide/runtime.js", () => ({ getLocale: () => locale.value }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it.each(["en", "ja"] as const)("names the destination and publication language in %s, retaining feedback without villages", async language => {
  locale.value = language;
  const render = (place?: string) => renderInRouter(() => createElement(Notice, { topicId: 1, lang: "en", place, firstPost: false, initial: [], editHref: "/t/1/edit" }));
  for (const place of [m.village_personal(), "Community garden"]) {
    expect(await render(place)).toContain(m.posted_topic_public({ place, lang: "English" }));
  }
  expect(await render()).toContain(m.posted_topic_public_no_place({ lang: "English" }));
});
