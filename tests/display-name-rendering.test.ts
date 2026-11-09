import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorLink } from "~/components/author-link";
import { ChatMessageView } from "~/components/chat-message";
import { DisplayNameEvidence } from "~/components/display-name-evidence";
import { DisplayNameFields } from "~/components/display-name-fields";
import { renderInRouter } from "./helpers/render-in-router";

it("isolates a supplementary Latin name in bylines and suppresses it in list labels", () => {
  const props = { handle: "writer", name: "山田太郎", latin: "Taro Yamada", reader: true };
  const html = renderToStaticMarkup(createElement(AuthorLink, { ...props, byline: true }));
  expect(html).toMatch(/<bdi dir="ltr"[^>]*>Taro Yamada<\/bdi>/);
  expect(html.indexOf("山田太郎")).toBeLessThan(html.indexOf("Taro Yamada"));
  expect(html.indexOf("Taro Yamada")).toBeLessThan(html.indexOf("@writer"));
  expect(renderToStaticMarkup(createElement(AuthorLink, props))).not.toContain("Taro Yamada");
});

it("renders stored fallback names in one field and exposes both differing names", () => {
  const render = (homeArea: "en" | "other", displayName: string | null, displayNameLatin: string | null) => renderToStaticMarkup(createElement(DisplayNameFields, { homeArea, initial: { displayName, displayNameLatin } }));
  const single = render("en", null, "Taylor Writer");
  expect(single).toMatch(/name="displayName"[^>]*value="Taylor Writer"/);
  expect(single).toMatch(/type="hidden" name="displayNameLatin" value=""/);
  const both = render("en", "光", "Light");
  expect(both).toMatch(/id="display-name-latin"[^>]*value="Light"/);
  expect(both).toMatch(/name="displayName"[^>]*value="光"/);
  expect(render("other", "光", null)).toMatch(/id="display-name-latin"/);
});

it("isolates a right-to-left name from the byline handle, keeping list labels name-only", () => {
  const props = { handle: "writer", name: "اسم الكاتب", reader: true };
  expect(renderToStaticMarkup(createElement(AuthorLink, { ...props, byline: true }))).toBe("<bdi>اسم الكاتب</bdi> @writer");
  expect(renderToStaticMarkup(createElement(AuthorLink, props))).toBe("<bdi>اسم الكاتب</bdi>");
  expect(renderToStaticMarkup(createElement(AuthorLink, { handle: "writer", reader: true, byline: true }))).toBe("@writer");
});

it("isolates chat names while rendering handles as separate text", () => {
  const html = renderToStaticMarkup(createElement(ChatMessageView, {
    message: { id: "rtl-name", author: "writer", authorName: "اسم الكاتب", own: false, lang: "ar", parts: [], createdSeq: 1, changedSeq: 1,
      createdAt: "2030-01-01T12:00:00Z", edited: false, deleted: false, hidden: true, translation: null },
    ended: false, slug: "names", originals: true, grouped: false,
    calendar: { timeZone: "UTC", locale: "en", now: Date.parse("2030-01-01T12:00:00Z") }, self: "reader", onReport: () => {},
  }));
  expect(html).toContain("<bdi>اسم الكاتب</bdi> @writer</span>");
});

it("exposes the stable handle on a named author link and omits absent evidence fields", async () => {
  const html = await renderInRouter(() => createElement(AuthorLink, { handle: "writer", name: "اسم الكاتب" }));
  expect(html).toContain('title="@writer"');
  expect(html).toContain('href="/u/writer"');
  const evidence = renderToStaticMarkup(createElement(DisplayNameEvidence, { names: { displayName: null, displayNameLatin: "Writer" } }));
  expect(evidence.match(/<dd>/g)).toHaveLength(1);
  expect(evidence).toContain("<bdi>Writer</bdi>");
});
