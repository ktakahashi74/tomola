import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { TranslatedEntry } from "~/components/translated-entry";
import type { EntryDisplay } from "~/lib/entry-display.server";
import { languageLabel } from "~/lib/language-label";
import { readingVersions } from "~/lib/reading.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

// Server rendering, visible without JavaScript: lang attributes, the currently displayed one of both HTML variants, and language-switch links.
function render(props: { kind?: "topic" | "reply"; display: EntryDisplay; url?: string }) {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: props.url ?? "/t/5" },
      createElement(TranslatedEntry, {
        id: 5,
        kind: props.kind ?? "topic",
        lang: "ja",
        title: props.kind === "reply" ? null : "原題",
        html: "<p>原文の本文</p>",
        display: props.display,
        meta: createElement("div", { className: "meta" }, "meta"),
      }),
    ),
  );
}

function expectBody(html: string, lang: string, text: string) {
  const bodies = [...html.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div>/g)];
  expect(bodies.some(([, attributes, body]) => new RegExp(`\\blang="${lang}"`).test(attributes) && body.replace(/<[^>]*>/g, "").includes(text))).toBe(true);
}

const translation: EntryDisplay["translation"] = {
  lang: "th",
  kind: "primary",
  engine: "gemini",
  model: "gemini-3.1-flash-lite",
  fallback: false,
  stale: false,
  html: "<p>ข้อความแปล</p>",
  title: { text: "ชื่อเรื่องแปล", kind: "primary", stale: false },
  headline: "ข้อความแปล",
  older: null,
  reportNotice: null,
};

describe("TranslatedEntry (server render)", () => {
  it("warns about mismatched formatting beside the translation label", () => {
    const html = render({ display: { shown: "translation", pending: false, translation: { ...translation!, structureMismatch: true } } });
    expect(html).toContain(m.translation_structure_note());
    expect(html).toContain(m.show_original());
    expect(render({ display: { shown: "original", pending: false, translation: { ...translation!, structureMismatch: true } } })).not.toContain(m.translation_structure_note());
  });
  it("shows a terminal failure without promising an automatic translation", () => {
    const html = render({ display: { shown: "original", pending: false, unavailable: true, translation: null } });
    expect(html).toContain(m.translation_unavailable());
    expect(html).not.toContain(m.label_pending());
  });
  it("keeps title, author, tools and body in order and follows each selected version's contents and time", () => {
    const source = `<h2 id="p-5-h-1">Source one</h2><h3 id="p-5-h-2">Source two</h3><h2 id="p-5-h-3">Source three</h2><p>${"あ".repeat(1001)}</p>`;
    const tr = { ...translation!, lang: "en" as const, title: { text: "Translated title", kind: "primary" as const, stale: false }, html: source.replaceAll("Source", "Translated").replace("あ".repeat(1001), "word ".repeat(880)),
      older: { kind: "human" as const, engine: null, model: null, title: { text: "Earlier title", kind: "human" as const, stale: true }, headline: null, html: '<h2 id="p-5-h-1">Earlier one</h2><h2 id="p-5-h-2">Earlier two</h2><p>Short.</p>' } };
    for (const shown of ["original", "translation", "older"] as const) {
      const display: EntryDisplay = { shown, pending: false, translation: tr };
      const reading = readingVersions(source, "ja", display);
      const html = renderToStaticMarkup(createElement(StaticRouter, { location: "/t/5" }, createElement(TranslatedEntry, {
        id: 5, kind: "topic", lang: "ja", title: "Source title", html: source, display, reading,
        meta: info => createElement("div", { "data-author": "" }, info && info.minutes >= 3 ? m.reading_minutes({ minutes: info.minutes }) : null),
        toolsBefore: createElement("span", { "data-question": "" }),
        toolsAfter: createElement("button", { "data-follow": "" }),
      })));
      const ordered = [html.indexOf("<h1"), html.indexOf("data-author"), html.indexOf("data-reading-tools"), html.indexOf('data-reading-body')];
      expect(ordered.every((value, index) => value >= 0 && (index === 0 || value > ordered[index - 1]))).toBe(true);
      if (shown === "older") {
        expect(html).not.toContain('aria-label="' + m.reading_toc() + '"');
        expect(html).not.toContain(m.reading_minutes({ minutes: reading.older!.minutes }));
        expect(html).toContain("Earlier title");
      } else {
        expect(html).toContain('aria-label="' + m.reading_toc() + '"');
        expect(html).toContain('href="#p-5-h-3"');
        expect(html).toContain(m.reading_minutes({ minutes: reading[shown]!.minutes }));
        expect(html).toContain(shown === "original" ? "Source one" : "Translated one");
      }
    }
  });

  it("renders the translation with lang=th on the title and the body, and a link to the original", () => {
    const html = render({ display: { shown: "translation", pending: false, translation } });
    expect(html).toContain('<h1 dir="auto" lang="th"');
    expect(html).toContain("ชื่อเรื่องแปล");
    expectBody(html, "th", "ข้อความแปล");
    expect(html).not.toContain("原文の本文");
    expect(html).toContain('href="?orig=5#p-5"');
  });

  it("renders the original with lang=ja and a link to the translation when the original is shown by default", () => {
    const html = render({ display: { shown: "original", pending: false, translation } });
    expect(html).toContain('<h1 dir="auto" lang="ja"');
    expect(html).toContain("原題");
    expectBody(html, "ja", "原文の本文");
    expect(html).toContain('href="?tr=5#p-5"');
  });

  it("keeps other query parameters in the toggle link and uses c- anchors for replies", () => {
    const html = render({ kind: "reply", display: { shown: "translation", pending: false, translation: { ...translation!, title: null } }, url: "/t/1?lang=th&orig=9" });
    expect(html).toContain('href="?lang=th&amp;orig=9&amp;orig=5#c-5"');
    expect(html).not.toContain("<h1");
  });

  it("uses the original title with lang=ja when only the body was translated", () => {
    const html = render({ display: { shown: "translation", pending: false, translation: { ...translation!, title: null } } });
    expect(html).toContain('<h1 dir="auto" lang="ja"');
    expect(html).toContain("原題");
    expect(html).toContain('<div dir="auto" lang="th"');
  });

  it("offers the older human-edited translation as a third choice, and renders it with lang=th and the older notice", () => {
    const older = { kind: "human" as const, engine: null, model: null, html: "<p>ข้อความเก่า</p>", title: { text: "ชื่อเก่า", kind: "human" as const, stale: true }, headline: "ข้อความเก่า" };
    const withOlder: EntryDisplay["translation"] = { ...translation!, older };
    const byDefault = render({ display: { shown: "translation", pending: false, translation: withOlder } });
    expect(byDefault).toContain('href="?orig=5#p-5"');
    expect(byDefault).toContain('href="?old=5#p-5"');
    expect(byDefault).toContain("ข้อความแปล");
    const showingOlder = render({ display: { shown: "older", pending: false, translation: withOlder } });
    expect(showingOlder).toContain('<h1 dir="auto" lang="th"');
    expect(showingOlder).toContain("ชื่อเก่า");
    expectBody(showingOlder, "th", "ข้อความเก่า");
    expect(showingOlder).not.toContain("ข้อความแปล");
    expect(showingOlder).toContain('href="?tr=5#p-5"');
    expect(showingOlder).toContain('href="?orig=5#p-5"');
    expect(showingOlder).not.toContain('href="?old=5#p-5"');
    // While showing the source, offer links to both the current and stale translations.
    const original = render({ display: { shown: "original", pending: false, translation: withOlder } });
    expect(original).toContain('href="?tr=5#p-5"');
    expect(original).toContain('href="?old=5#p-5"');
  });

  it("shows a small notice (role=note) while the translation has an open report, and after it was redone because of a report", () => {
    const withNotice = (reportNotice: "open" | "retried" | null, shown: "translation" | "original" = "translation") =>
      render({ display: { shown, pending: false, translation: { ...translation!, reportNotice } } });
    expect(withNotice("open")).toContain('role="note"');
    expect(withNotice("retried")).toContain('role="note"');
    expect(withNotice(null)).not.toContain('role="note"');
    // Do not show translation warnings while displaying the source.
    expect(withNotice("open", "original")).not.toContain('role="note"');
  });

  it("shows the original without a toggle while the translation is pending", () => {
    const html = render({ display: { shown: "original", pending: true, translation: null } });
    expectBody(html, "ja", "原文の本文");
    expect(html).not.toContain("?tr=");
    expect(html).not.toContain("?orig=");
  });

  it("renders nothing extra when no translation is wanted or available", () => {
    const html = render({ display: { shown: "original", pending: false, translation: null } });
    expect(html).not.toContain("<a ");
  });

  it("in the reading layout, says what is read once (to the byline) and supplies the switch and notes to its header", () => {
    const seen: Array<{ text: string; title?: string }> = [];
    const statuses: ReactNode[] = [];
    const reading = (display: EntryDisplay) => {
      const source = '<h2 id="p-5-h-1">One</h2><p>text</p>';
      return renderToStaticMarkup(createElement(StaticRouter, { location: "/t/5" }, createElement(TranslatedEntry, {
        id: 5, kind: "topic", lang: "ja", title: "原題", html: source, display, reading: readingVersions(source, "ja", display),
        readingLanguage: { choice: { current: "th", usual: "en", enabled: ["ja", "en", "th"] } },
        meta: (_info, controls, view, languageMenu) => { seen.push(view); statuses.push(controls); return createElement("div", { "data-byline": "" }, view.text, languageMenu, controls); },
      })));
    };
    const shown = reading({ shown: "translation", pending: false, translation: { ...translation!, fallback: true, structureMismatch: true } });
    expect(seen[0].text).toBe(m.label_from_lang_machine_engine({ lang: languageLabel("ja"), engine: "Gemini" }));
    expect(seen[0].title).toBe("gemini-3.1-flash-lite");
    // The label itself is not drawn again in the tools row; the notes and the switch are.
    const tools = shown.slice(shown.indexOf("data-byline"));
    expect(tools).not.toContain(m.label_machine({ engine: "Gemini" }));
    expect(tools).toContain(m.label_fallback());
    expect(tools).toContain(m.translation_structure_note());
    expect(tools).toContain(m.show_original());
    // Reading the original needs no translation status, even when a translation is available in the menu.
    const original = reading({ shown: "original", pending: false, translation });
    expect(seen[1].text).toBe("日本語");
    expect(statuses[1]).toBeNull();
    expect(original).not.toContain(m.show_translation());
    // Pending: the original is read; the row says the translation is coming.
    const pending = reading({ shown: "original", pending: true, translation: null });
    expect(seen[2].text).toBe("日本語");
    expect(pending).toContain(m.label_pending());
    const unavailable = reading({ shown: "original", pending: false, unavailable: true, translation: null });
    expect(unavailable).toContain(m.translation_unavailable());
    for (const html of [shown, original, pending, unavailable]) expect(html).toContain(m.reading_other_languages_read());
  });

  it("omits an empty reading tools row without removing the body or static contents", () => {
    const source = '<h2 id="p-5-h-1">One</h2><h2 id="p-5-h-2">Two</h2><h2 id="p-5-h-3">Three</h2>';
    const display: EntryDisplay = { shown: "original", pending: false, translation: null };
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: "/t/5" }, createElement(TranslatedEntry, {
      id: 5, kind: "topic", lang: "en", title: "Source title", html: source, display, meta: null,
      reading: readingVersions(source, "en", display),
    })));
    expect(html).not.toContain("data-reading-tools");
    expect(html).toContain("data-reading-body");
    expect(html).toContain('href="#p-5-h-3"');
    expect(html).not.toContain("aria-current");
  });
});
