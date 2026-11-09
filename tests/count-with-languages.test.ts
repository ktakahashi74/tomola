import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountWithLanguages } from "~/components/count-with-languages";
import { StancePanel, type StancePanelProps } from "~/components/stance-panel";
import { LANG_LABELS } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";
import { escapeRegex, messageMarkup } from "./helpers/message-markup";
import { setTestLocale } from "./stubs/paraglide-runtime";

// CountWithLanguages and StancePanel accept and show only totals and language counts, never language names or per-language numbers.
// Use actual messages/*.json, not the empty message stubs normally used in tests.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => setTestLocale("en"));

const html = (element: ReactElement) => renderToStaticMarkup(element);
const count = (total: number, langs: number, kind: "insightful" | "stances") => html(createElement(CountWithLanguages, { count: { total, langs }, kind }));

describe("CountWithLanguages", () => {
  it("keeps singular and plural language counts inside parentheses in full and short labels", () => {
    for (const langs of [1, 3]) {
      for (const short of [false, true]) {
        const out = html(createElement(CountWithLanguages, { count: { total: 9, langs }, kind: "insightful", short }));
        const visible = out.match(/<span aria-hidden="true">([^<]+)<\/span>/)![1];
        expect(visible).toMatch(new RegExp(`\\(${langs} language${langs === 1 ? "" : "s"}\\)$`));
        expect(visible).not.toContain("·");
        expect(visible.startsWith("Insightful ")).toBe(!short);
      }
    }
  });

  it("shows the Insightful total with a parenthesized language count; nothing when there is none", () => {
    expect(count(9, 3, "insightful")).toContain(messageMarkup(m.insightful_count({ total: 9, langs: 3 })));
    expect(count(0, 0, "insightful")).toBe("");
    // The same shape applies to one language; wording handles the singular form.
    expect(count(2, 1, "insightful")).toContain(messageMarkup(m.insightful_count({ total: 2, langs: 1 })));
    setTestLocale("ja");
    expect(count(9, 3, "insightful")).toContain(messageMarkup(m.insightful_count({ total: 9, langs: 3 })));
    expect(count(2, 1, "insightful")).toContain(messageMarkup(m.insightful_count({ total: 2, langs: 1 })));
  });

  it("shows a stance distribution as the number of languages that answered, and says so when no one has", () => {
    expect(count(7, 4, "stances")).toContain(messageMarkup(m.stance_langs({ langs: 4 })));
    expect(count(5, 1, "stances")).toContain(messageMarkup(m.stance_langs({ langs: 1 })));
    expect(count(0, 0, "stances")).toContain(messageMarkup(m.stance_none()));
    setTestLocale("ja");
    expect(count(7, 4, "stances")).toContain(messageMarkup(m.stance_langs({ langs: 4 })));
    expect(count(5, 1, "stances")).toContain(messageMarkup(m.stance_langs({ langs: 1 })));
    expect(count(0, 0, "stances")).toContain(messageMarkup(m.stance_none()));
  });

  it("reads the full sentence as text while hiding the short visual count", () => {
    expect(count(9, 3, "insightful")).toContain(`<span class="sr-only">${messageMarkup(m.insightful_count_aria({ total: 9, langs: 3 }))}</span>`);
    expect(count(9, 3, "insightful")).toContain('aria-hidden="true"');
    expect(count(9, 3, "insightful")).not.toContain("aria-label");
    expect(count(7, 4, "stances")).toContain(messageMarkup(m.stance_langs({ langs: 4 })));
    expect(count(7, 4, "stances")).not.toContain("aria-label");
    for (const markup of [count(9, 3, "insightful"), count(7, 4, "stances")]) for (const name of Object.values(LANG_LABELS)) expect(markup).not.toContain(name);
  });

  it("shortens a stance line to the number of languages where there is little room, and still reads the whole sentence", () => {
    const short = html(createElement(CountWithLanguages, { count: { total: 7, langs: 4 }, kind: "stances", short: true }));
    expect(short).toContain(`<span class="sr-only">${messageMarkup(m.stance_langs({ langs: 4 }))}</span>`);
    expect(short).toContain(`aria-hidden="true">${messageMarkup(m.stance_langs_short({ langs: 4 }))}`);
    expect(short).not.toContain("aria-label");
  });

  it("takes only the total, the number of languages and the kind: a count per language does not type-check", () => {
    // Type contract only; this function is never rendered. Typecheck must fail if @ts-expect-error is ineffective.
    const contract = () => [
      // @ts-expect-error: a count per language is not a property of the count
      createElement(CountWithLanguages, { count: { total: 1, langs: 1, byArea: [{ area: "ja", count: 1 }] }, kind: "stances" }),
      // @ts-expect-error: language names are not accepted
      createElement(CountWithLanguages, { count: { total: 1, langs: 1 }, kind: "stances", names: ["日本語"] }),
      // @ts-expect-error: the kind is one of insightful and stances
      createElement(CountWithLanguages, { count: { total: 1, langs: 1 }, kind: "areas" }),
      createElement(CountWithLanguages, { count: { total: 1, langs: 1 }, kind: "insightful" }),
    ];
    expect(typeof contract).toBe("function");
  });
});

// Render StancePanel inside a static router because it uses a fetcher.
async function render(panels: StancePanelProps[]): Promise<string> {
  const routes = [{ path: "/", Component: () => createElement("div", null, panels.map((p) => createElement(StancePanel, { key: p.questionId, ...p }))) }];
  const handler = createStaticHandler(routes);
  const context = (await handler.query(new Request("http://localhost/"))) as StaticHandlerContext;
  const router = createStaticRouter(routes, context);
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
}
const base: StancePanelProps = {
  questionId: 12,
  stance: { position: null, version: 0 },
  distribution: null,
  peekHref: "/latest?peek=12#q-12",
  returnTo: "/latest#q-12",
  canChoose: true,
};
const distribution = { questionId: 12, total: 9, counts: { agree: 5, disagree: 3, neither: 1 }, langs: 3, asOf: "2026-10-05T00:00:00.000Z" };

describe("StancePanel", () => {
  it("before the member chose: three buttons, none pressed, no distribution, and a link to see the results first", async () => {
    const out = await render([{ ...base, compact: true }]);
    for (const label of [m.stance_agree(), m.stance_disagree(), m.stance_neither()]) expect(out).toContain(`>${messageMarkup(label)}</button>`);
    expect((out.match(/aria-pressed="false"/g) ?? []).length).toBe(3);
    expect(out).not.toContain('aria-pressed="true"');
    expect(out).toContain('href="/latest?peek=12#q-12"');
    expect(out).toContain(messageMarkup(m.stance_peek()));
    expect(out).not.toContain(messageMarkup(m.stance_counts_label()));
    expect(out).not.toContain(messageMarkup(m.stance_withdraw()));
    // Submit the question, version and return path; position comes from the pressed name=position button.
    expect(out).toContain('name="questionId" value="12"');
    expect(out).toContain('name="version" value="0"');
    expect(out).toContain('name="returnTo" value="/latest#q-12"');
    expect(out).toContain('action="/stance"');
    expect((out.match(/name="position"/g) ?? []).length).toBe(3);
  });

  it("after the member chose: the pressed button, the three numbers, the number of languages and the note; a withdraw button; the privacy line only outside a list", async () => {
    const chosen = { ...base, stance: { position: "agree" as const, version: 3 }, distribution };
    const full = await render([chosen]);
    expect(full).toContain('aria-pressed="true"');
    expect(full).toContain(`${messageMarkup(m.stance_agree())} <span`);
    expect(full).toMatch(new RegExp(`${escapeRegex(messageMarkup(m.stance_agree()))} <span class="font-semibold">5</span>`));
    expect(full).toMatch(new RegExp(`${escapeRegex(messageMarkup(m.stance_disagree()))} <span class="font-semibold">3</span>`));
    expect(full).toMatch(new RegExp(`${escapeRegex(messageMarkup(m.stance_neither()))} <span class="font-semibold">1</span>`));
    expect(full).toContain(messageMarkup(m.stance_langs({ langs: 3 })));
    expect(full.match(/role="note"/g)).toHaveLength(1);
    expect(full).toContain('name="version" value="3"');
    expect(full).toContain('value="none"');
    expect(full).toContain(messageMarkup(m.stance_withdraw()));
    expect(full).not.toContain(messageMarkup(m.stance_peek()));
    // The disclosure line and a link to /settings/stances#privacy.
    expect(full).toContain(messageMarkup(m.stance_privacy_line()));
    expect(full).toContain('href="/settings/stances#privacy"');
    // Compact list items omit both the disclosure line and the distribution note.
    const compact = await render([{ ...chosen, compact: true }]);
    expect(compact).not.toContain(messageMarkup(m.stance_privacy_line()));
    expect(compact).not.toContain("/settings/stances#privacy");
    expect(compact).not.toContain('role="note"');
    expect(compact).not.toContain(messageMarkup(m.stance_note_short()));
  });

  it("keeps one note immediately after the counts and languages on a question page, including empty results", async () => {
    expect(await render([base])).not.toContain('role="note"');
    for (const view of [distribution, { ...distribution, total: 0, langs: 0, counts: { agree: 0, disagree: 0, neither: 0 } }]) {
      const out = await render([{ ...base, distribution: view }]);
      expect(out.match(/role="note"/g)).toHaveLength(1);
      const languages = count(view.total, view.langs, "stances");
      expect(out).toContain(`</ul><p>${languages}</p><p role="note"`);
    }
  });

  it("shows a distribution that the page was given (peeked) without a stance, and the trigger of 'rethink' as a hidden field when there is one", async () => {
    const peeked = await render([{ ...base, distribution, triggerEntryId: 77, compact: true }]);
    expect(peeked).toContain(messageMarkup(m.stance_langs({ langs: 3 })));
    expect(peeked).not.toContain(messageMarkup(m.stance_peek()));
    expect(peeked).toContain('name="trigger" value="77"');
    expect(peeked).not.toContain('role="note"');
    expect(peeked).not.toContain(messageMarkup(m.stance_note_short()));
    expect(await render([{ ...base, compact: true }])).not.toContain('name="trigger"');
  });

  it("closed (a hidden question): no choice, only a withdraw for a member who has a stance; no peek link", async () => {
    const closed = await render([{ ...base, canChoose: false }]);
    expect(closed).toContain(messageMarkup(m.stance_closed()));
    expect(closed).not.toContain('name="position" value="agree"');
    expect(closed).not.toContain(messageMarkup(m.stance_peek()));
    const withStance = await render([{ ...base, canChoose: false, stance: { position: "disagree", version: 2 } }]);
    expect(withStance).toContain(messageMarkup(m.stance_withdraw()));
    expect(withStance).not.toContain('value="agree"');
  });

  it("shows a message left by a plain form submission (conflict, limit)", async () => {
    expect(await render([{ ...base, message: "conflict" }])).toContain(messageMarkup(m.stance_conflict()));
    expect(await render([{ ...base, message: "rate_limited" }])).toContain(messageMarkup(m.stance_rate_limited()));
  });

  it("has no view by language and no language name; two panels on one page carry their own question (the fetcher key is per question)", async () => {
    const out = await render([
      { ...base, questionId: 12, stance: { position: "agree", version: 1 }, distribution, compact: true },
      { ...base, questionId: 13, peekHref: "/latest?peek=13#q-13", compact: true },
    ]);
    for (const name of Object.values(LANG_LABELS)) expect(out).not.toContain(name);
    expect(out).not.toMatch(/by language|per language|各言語|言語別|言語の別/i);
    expect(out).toContain('name="questionId" value="12"');
    expect(out).toContain('name="questionId" value="13"');
    // Both panels render with no host loader data, and their controls address their own question.
    expect((out.match(/action="\/stance"/g) ?? []).length).toBe(2);
    expect(count(9, 3, "insightful")).toContain(messageMarkup(m.insightful_count({ total: 9, langs: 3 })));
  });

  it("in Japanese: the buttons, the counts, the languages and the note", async () => {
    setTestLocale("ja");
    const out = await render([{ ...base, stance: { position: "neither", version: 1 }, distribution }]);
    for (const label of [m.stance_agree(), m.stance_disagree(), m.stance_neither(), m.stance_withdraw()]) expect(out).toContain(messageMarkup(label));
    expect(out).toContain(messageMarkup(m.stance_langs({ langs: 3 })));
    expect(out.match(/role="note"/g)).toHaveLength(1);
    expect(out).toContain(messageMarkup(m.stance_privacy_line()));
  });
});
