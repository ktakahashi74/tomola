import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatNushiBody } from "~/components/chat-message";
import { NushiCallStatus } from "~/components/nushi";
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
