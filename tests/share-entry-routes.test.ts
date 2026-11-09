import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTopic } from "~/lib/entries.server";
import { shareBookmarklet } from "~/lib/share-bookmarklet";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("share_route_reader");
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

it("withholds shared input for invalid URLs, proposals and alternative questions", async () => {
  const route = await import("~/routes/topic-new");
  const question = await createTopic(h.db, h.ids.share_route_reader, { title: "Original question", body: "The original question.", asksStance: true, lang: "en" });
  if (!question.ok) throw new Error(question.error);
  const shared = { url: "https://example.org/shared", title: "Shared title", text: "Shared quotation" };
  for (const values of [
    { ...shared, url: "javascript:alert(1)" },
    { ...shared, propose_term: "1" },
    { ...shared, alt_of: String(question.id) },
  ]) {
    const path = `/t/new?${new URLSearchParams(values)}`;
    const loaded = await route.loader(h.args(h.request(path, { as: "share_route_reader" })));
    expect(loaded.sharePrefilled).toBe(false);
    expect(JSON.stringify(loaded.prefill)).not.toMatch(/Shared title|Shared quotation|example\.org\/shared/);
  }
});

it("renders this site's bookmarklet as read-only text without a JavaScript link", async () => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5173");
  const route = await import("~/routes/settings");
  const loaderData = await route.loader(h.args(h.request("/settings", { as: "share_route_reader" })));
  expect(loaderData.shareBookmarklet).toBe(shareBookmarklet("http://localhost:5173"));
  const html = await renderInRouter(() => createElement(route.default, { loaderData } as never), "/settings");
  expect(html).toMatch(/<textarea[^>]*readonly=""[^>]*>javascript:/i);
  expect(html).not.toMatch(/href="javascript:/i);
});
