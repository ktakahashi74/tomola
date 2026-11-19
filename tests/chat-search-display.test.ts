import { chatConsentData } from "./helpers/loader-fixtures";
import { createElement } from "react";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import { expect, it, vi } from "vitest";
import { renderInRouter } from "./helpers/render-in-router";
import { ChatSearchResults } from "~/components/chat-search-results";
import { chatSearchExcerpt } from "~/lib/village-chat-search.server";
import VillageChat, { ErrorBoundary } from "~/routes/village-chat";
import ChatSearch from "~/routes/village-chat-search";
import { m } from "~/paraglide/messages.js";
import { routeElement } from "./helpers/route-fixtures";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it("renders excerpts, names and highlights as text, with no query in the destination", async () => {
  const raw = '<script>alert("excerpt")</script> %_\\';
  const html = await renderInRouter(() => createElement(ChatSearchResults, {
    slug: "safe-chat", linkLang: "en", hits: [{ id: "a".repeat(32), author: "safe_author", authorName: "<img src=x>", createdAt: "2026-01-01T00:00:00Z", createdSeq: 1,
      matches: [{ source: "original", lang: "ja", excerpt: { before: "before ", match: raw, after: " after" } }, { source: "translation", lang: "en", excerpt: { before: "", match: raw, after: "" } }],
    }],
  }));
  expect(html).toContain("<mark>&lt;script&gt;");
  expect(html).toContain("&lt;img src=x&gt;");
  expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
  expect(html).toContain("from=search"); expect(html).toContain(`#chat-${"a".repeat(32)}`);
  expect(html).not.toMatch(/href="[^"]*(?:q=|excerpt)/);
  expect(html).toContain(m.search_match_original()); expect(html).toContain(m.chat_search_match_translation());
});

it("bounds Unicode excerpts around the database match without splitting surrogate pairs", () => {
  const result = chatSearchExcerpt(`${"😀".repeat(100)}検索${"文".repeat(200)}`, 101, 2);
  expect(result.match).toBe("検索");
  expect([...result.before]).toHaveLength(61); expect([...result.after]).toHaveLength(101);
  expect(result.before.startsWith("…")).toBe(true); expect(result.after.endsWith("…")).toBe(true);
});

it("hides the search entrance until consent and displays unavailable destinations without chat content", async () => {
  const consent = await renderInRouter(() => routeElement(VillageChat, { loaderData: chatConsentData({ village: { slug: "safe-chat", name: "Safe chat", kind: "open", description: "", language: null, iconUrl: "" }, readers: 1 }) }), "/v/safe-chat/chat");
  expect(consent).not.toContain("/chat/search");
  const unavailable = await renderInRouter(() => createElement(ErrorBoundary, { error: new ErrorResponseImpl(404, "Not found", { error: "chat_message_unavailable" }), params: { slug: "safe-chat" } }), "/v/safe-chat/chat");
  expect(unavailable).toContain(m.chat_search_message_unavailable()); expect(unavailable).not.toContain('role="log"');
  expect(unavailable).toContain('href="/v/safe-chat/chat"'); expect(unavailable).toContain(m.chat_search_back());
  const cases = [
    { loaderData: { unavailable: true } },
    { loaderData: { unavailable: false, slug: "safe-chat", name: "Safe chat", linkLang: null }, actionData: { error: "not_found" } },
  ] satisfies Array<Pick<Parameters<typeof ChatSearch>[0], "loaderData" | "actionData">>;
  for (const props of cases) {
    const denied = await renderInRouter(() => routeElement(ChatSearch, { ...props, params: { slug: "safe-chat" } }), "/v/safe-chat/chat/search");
    expect(denied).toContain(m.chat_search_message_unavailable()); expect(denied).not.toContain('role="search"');
    expect(denied).toContain('href="/v/safe-chat/chat"'); expect(denied).toContain(m.chat_search_back());
  }
});
