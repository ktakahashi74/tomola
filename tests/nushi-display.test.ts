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
