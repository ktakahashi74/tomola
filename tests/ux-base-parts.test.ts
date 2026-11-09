import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PageHeader } from "~/components/page-header";
import { CountBadge, UnreadDot } from "~/components/unread";
import { ActionPanel } from "~/components/ui/action-panel";
import { Button } from "~/components/ui/button";
import { MoreInfo } from "~/components/ui/more-info";
import { jsonMessages } from "./helpers/messages-json";
import { setTestMessages } from "./stubs/paraglide-messages";

beforeEach(() => setTestMessages(jsonMessages()));
afterEach(() => setTestMessages());

const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

it("a pressed toggle is marked for assistive technology, in its data and with a check", () => {
  const on = render(createElement(Button, { variant: "outline", pressed: true }, "Insightful"));
  expect(on).toContain('aria-pressed="true"');
  expect(on).toContain('data-pressed=""');
  expect(on).toContain("<svg");
  const off = render(createElement(Button, { variant: "outline", pressed: false }, "Insightful"));
  expect(off).toContain('aria-pressed="false"');
  expect(off).not.toContain('data-pressed=""');
  expect(off).not.toContain("<svg");
  // The visual alone, for a button whose label is an action: no toggle meaning for assistive technology.
  const marked = render(createElement(Button, { variant: "outline", marked: true }, "Revoke"));
  expect(marked).toContain('data-pressed=""');
  expect(marked).toContain("<svg");
  expect(marked).not.toContain("aria-pressed");
  // An ordinary button is not a toggle.
  expect(render(createElement(Button, null, "Save"))).not.toContain("aria-pressed");
});

it("a count badge shows nothing for zero, names itself, and caps a large number", () => {
  expect(render(createElement(CountBadge, { count: 0, label: "x" }))).toBe("");
  const small = render(createElement(CountBadge, { count: 7, label: "7 unread" }));
  expect(small).toContain('aria-label="7 unread"');
  expect(small).toContain(">7<");
  expect(render(createElement(CountBadge, { count: 120, label: "many" }))).toContain(">99+<");
  expect(render(createElement(CountBadge, { count: 120, label: "many", cap: 1000 }))).toContain(">120<");
});

it("an unread dot is drawn but read out as its label", () => {
  const html = render(createElement(UnreadDot, { label: "unread" }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('<span class="sr-only">unread</span>');
});

it("a page header keeps the heading for readers when it is not drawn, and puts actions at the right", () => {
  const hidden = render(createElement(PageHeader, { title: "Home", hideTitle: true, actions: createElement("button", null, "Act") }));
  expect(hidden).toMatch(/<h1 class="sr-only">Home<\/h1>/);
  expect(hidden).toContain("justify-end");
  expect(hidden).toContain("Act");
  const alone = render(createElement(PageHeader, { title: "Home", hideTitle: true }));
  expect((alone.match(/<h1/g) ?? []).length).toBe(1);
  const shown = render(createElement(PageHeader, { title: "Follow", purpose: "Why", switches: createElement("nav", null, "tabs") }));
  expect(shown).toMatch(/<h1 class="heading-1">Follow<\/h1>/);
  expect(shown.indexOf("Why")).toBeGreaterThan(shown.indexOf("Follow"));
  expect(shown.indexOf("tabs")).toBeGreaterThan(shown.indexOf("Why"));
});

it("the two hiding parts are native disclosures that need no script", () => {
  const more = render(createElement(MoreInfo, null, "The rule"));
  expect(more).toMatch(/<details[^>]*class="more-info"[^>]*><summary>/);
  expect(more).toContain(">The rule<");
  const panel = render(createElement(ActionPanel, { label: "Report", children: "Form" }));
  expect(panel).toMatch(/<details[^>]*class="action-panel"/);
  expect(panel).toContain("Report</summary>");
  expect(panel).not.toContain("▸");
});
