import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import TopicNew, { loader } from "~/routes/topic-new";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { m } from "~/paraglide/messages.js";
import { messageMarkup } from "./helpers/message-markup";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("share_writer"); });
afterAll(() => h?.restore());
const load = async (query: string) => (await loader(h.args(h.request(`/t/new?${query}`, { as: "share_writer" }))));

it("prefills only the body, leaves a share as an ordinary topic and displays the review notice", async () => {
  const loaded = await load("url=https%3A%2F%2Fexample.org%2Fa&title=Example");
  expect(loaded).toMatchObject({ prefill: { title: "", body: "[Example](https://example.org/a)\n\n" }, asksStance: false, sharePrefilled: true });
  const html = await renderInRouter(() => createElement(TopicNew, { loaderData: loaded, params: {}, matches: [] } as never), "/t/new");
  expect(html).toContain(messageMarkup(m.share_prefill_notice()));
  expect(html).toContain("[Example](https://example.org/a)");
});

it("ignores sharing whenever the alternative or glossary-proposal parameter is supplied, even if invalid", async () => {
  for (const query of ["alt_of=bad", "alt_of=999999", "propose_term=0", "propose_term=1"]) {
    const original = await load(query);
    expect(await load(`${query}&url=https%3A%2F%2Fexample.org%2Fa&title=Example`)).toMatchObject({ prefill: original.prefill, sharePrefilled: false });
  }
});

it("keeps the original shared query through the anonymous login redirect", async () => {
  const query = new URLSearchParams({ url: "https://example.org/a?q=1&b=2", title: "Shared title", text: "A quote" });
  const result = await h.outcome(async () => (await loader(h.args(h.request(`/t/new?${query}`)))));
  expect(result.status).toBe(302);
  expect(new URL(result.location!, "http://localhost").searchParams.get("next")).toBe(`/t/new?${query}`);
});
