import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatNushiBody } from "~/components/chat-message";
import { NushiCallStatus } from "~/components/nushi";
import { NushiSources } from "~/components/nushi-sources";
import { chatParts } from "~/lib/village-chat";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("react-router", async original => ({ ...await original<typeof import("react-router")>(), useRouteLoaderData: () => ({ siteOrigin: "https://example.test" }) }));

it.each(["pending", "processing"])("keeps animated punctuation out of the %s announcement", state => {
  const html = renderToStaticMarkup(createElement(NushiCallStatus, { state, failure: null }));
  expect(html).toContain('role="status"');
  expect(html).toContain(`${m.nushi_pending()}<span aria-hidden="true" class="nushi-pending-dots"><span>.</span><span>.</span><span>.</span></span>`);
  expect(html.replace(/<span aria-hidden="true"[\s\S]*<\/span>/, "").replace(/<[^>]*>/g, "")).toBe(m.nushi_pending());
});

it("shortens only same-origin AI source labels while preserving exact destinations", () => {
  const internal = "https://example.test/t/7?orig=7#material:~:text=An%20orchard";
  const external = "https://elsewhere.test/t/7#material:~:text=An%20orchard";
  const spoof = "https://example.test.elsewhere.test/t/7";
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(`${internal}\n${external}\n${spoof}`) }));
  expect(html).toContain(`href="${internal}"`);
  expect(html).toContain(`>${m.nushi_open_post()}</a>`);
  expect(html).toContain(`>${external}</a>`);
  expect(html).toContain(`>${spoof}</a>`);
  expect(html).not.toContain(`>${internal}</a>`);
});

it("preserves URLs in readings and original and translated quotations while shortening the source line", () => {
  const url = "https://example.test/t/7#p-7:~:text=An%20orchard";
  const body = `Read more at ${url} [1]\n\n[1] @author\nOriginal quote with ${url} in its prose.\nTranslated quote with ${url} in its prose.\n${url}`;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(body) }));
  expect(html.split(`>${url}</a>`)).toHaveLength(4);
  expect(html.split(`>${m.nushi_open_post()}</a>`)).toHaveLength(2);
  expect(html.split(`href="${url}"`)).toHaveLength(5);
});

it.each(["/v/orchard", "/settings/profile", "/t/word", "/t/7/extra"])("preserves a standalone URL to %s", path => {
  const url = `https://example.test${path}`;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(url) }));
  expect(html).toContain(`>${url}</a>`);
  expect(html).not.toContain(m.nushi_open_post());
});

it("shows source authors and dates on one metadata line with quotations closed", () => {
  const html = renderToStaticMarkup(createElement(NushiSources, { sources: [
    { author: "@a", date: "2026-04-02", href: "/t/1?orig=1#p-1", quote: "Original passage" },
    { author: "@c", date: "2026-04-03", href: "/t/3?orig=3#p-3", quote: "Another passage" },
  ] }));
  expect(html).toMatch(/<p data-nushi-sources="true" class="ui-meta">.*@a 4\/2.*@c 4\/3<\/a><\/span><\/p>/);
  expect(html).toContain('href="/t/1?orig=1#p-1"');
  expect(html).toContain(`<summary class="cursor-pointer underline">${m.nushi_quotes()}</summary>`);
  expect(html).toMatch(/<details data-nushi-quotes="true" class="space-y-3 ui-help">/);
  expect(html).not.toContain(" open=");
  expect(html.indexOf("Original passage")).toBeGreaterThan(html.indexOf("<details"));
});

it.each([false, true])("links inline numbers and folds only quotations after translated=%s readings", translated => {
  const href = "https://example.test/t/7?orig=7#p-7:~:text=An%20orchard";
  const reading = "The post asks for public review. [1]";
  const block = `[1] @@writer · 2026-04-02\nOriginal passage\n\nWith context.\n訳の箇所。\n${href}`;
  const body = `${reading}\n\n${block}\n\nConsulted range.`;
  const start = reading.length + 2;
  const sources = { citationRanges: [[start, start + block.length] as [number, number]], scopeStart: start + block.length + 2, bodyLength: body.length };
  const shown = translated ? body.replace("The post asks for public review.", "公開の検討を求める投稿。") : body;
  const html = renderToStaticMarkup(createElement(ChatNushiBody, { parts: chatParts(shown), sources }));
  expect(html).toContain(`<a class="ui-meta underline" href="${href}">[1]</a>`);
  expect(html).toContain(`<a class="whitespace-nowrap underline" href="${href}">@writer 4/2</a>`);
  expect(html).toContain("Original passage\n\nWith context.\n訳の箇所。");
  expect(html).toContain(`<p class="ui-meta">Consulted range.</p>`);
  expect(html).not.toContain(" open=");
  expect(html).not.toContain(m.chat_nushi_read());
  expect(html.split("<details")).toHaveLength(2);
  expect(html).toContain(`>${m.nushi_open_post()}</a>`);
});
