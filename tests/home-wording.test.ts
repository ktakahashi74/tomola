import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { m } from "~/paraglide/messages.js";
import { drawHome as renderHome, homeText as text, setupHomeWording } from "./helpers/home-wording";
import { messageMarkup } from "./helpers/message-markup";
import type { RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";

// Render the home with its actual messages and check which controls each state shows.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
beforeAll(async () => { h = await setupHomeWording(); });
afterAll(() => h.restore());
afterEach(() => {
  setTestLocale("en");
  vi.unstubAllEnvs();
});
const drawHome = (locale: "en" | "ja", as = "hana", actionData?: unknown) => renderHome(h, locale, as, actionData);

describe("the stream home in English and in Japanese", () => {
  it("says the order, the switch, the filters, the row counts in English", async () => {
    const html = await drawHome("en");
    const t = text(html);
    // A post with no reply shows no "0 replies", and the name of the filter is read out but not drawn.
    expect(t).not.toContain(messageMarkup(m.home_replies({ count: 0 })));
    expect(html).toContain(`aria-label="${messageMarkup(m.home_order_label())}"`);
    expect(html).toContain(`aria-label="${messageMarkup(m.list_filter_label())}"`);
    expect(html).not.toContain(`aria-label="${messageMarkup(m.home_origlang_label())}"`);
    expect(t).not.toContain(messageMarkup(m.home_order_label()));
    expect(t).not.toContain(messageMarkup(m.filter_prefix()));
    expect(html).not.toContain("<textarea");
  });

  it("says the same in Japanese, with the words of the glossary (なるほど, 問い, 原文, 題)", async () => {
    const html = await drawHome("ja");
    const t = text(html);
    expect(t).not.toContain(messageMarkup(m.home_replies({ count: 0 })));
    expect(html).toContain(`aria-label="${messageMarkup(m.home_order_label())}"`);
    expect(html).toContain(`aria-label="${messageMarkup(m.list_filter_label())}"`);
    expect(html).not.toContain(`aria-label="${messageMarkup(m.home_origlang_label())}"`);
    expect(t).not.toContain(messageMarkup(m.home_order_label()));
    expect(t).not.toContain(messageMarkup(m.filter_prefix()));
  });

  it("an untranslated title has the pending label", async () => {
    // john reads English: the Japanese posts are shown as translations once there are some (none yet: the original with "waiting for translation")
    const waiting = text(await drawHome("en", "john"));
    expect(waiting).toContain(messageMarkup(m.label_pending_short()));
  });

});

it.each(["en", "ja"] as const)("names a collapsed filter for screen readers only, without a space after a Japanese colon in %s", async locale => {
  const html = await drawHome(locale);
  const label = `${m.filter_prefix()}${locale === "ja" ? "" : " "}${m.home_filter_all()}`;
  expect(html).toContain(`aria-label="${messageMarkup(label)}"`);
  // The drawn text is the chosen value alone.
  expect(text(html)).not.toContain(messageMarkup(m.filter_prefix()));
  expect(html).toMatch(new RegExp(`<summary[^>]*>${messageMarkup(m.home_filter_all())}<`));
});

it("puts no folded ordering rule in the order row", async () => {
  for (const locale of ["en", "ja"] as const) {
    for (const order of ["created", "activity", "insightful"] as const) {
      const html = await renderHome(h, locale, "hana", undefined, `/?order=${order}`);
      expect(html).not.toMatch(/class="[^"]*\bmore-info\b/);
      expect(html).not.toContain('href="/principles#rules"');
    }
  }
});
