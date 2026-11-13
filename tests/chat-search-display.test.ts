import { createElement } from "react";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import { expect, it, vi } from "vitest";
import { renderInRouter } from "./helpers/render-in-router";
import { ChatSearchResults } from "~/components/chat-search-results";
import { chatSearchExcerpt } from "~/lib/village-chat-search.server";
import VillageChat, { ErrorBoundary } from "~/routes/village-chat";
import { m } from "~/paraglide/messages.js";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";

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
  const consent = await renderInRouter(() => createElement(VillageChat, { loaderData: {
    village: { slug: "safe-chat", name: "Safe chat" }, readers: 1, consentRequired: true, consentVersion: CHAT_CONSENT_VERSION, previousConsentVersion: null, privacyAvailable: false,
  } } as never), "/v/safe-chat/chat");
  expect(consent).not.toContain("/chat/search");
  const unavailable = await renderInRouter(() => createElement(ErrorBoundary, { error: new ErrorResponseImpl(404, "Not found", { error: "chat_message_unavailable" }) } as never), "/v/safe-chat/chat");
  expect(unavailable).toContain(m.chat_search_message_unavailable()); expect(unavailable).not.toContain('role="log"');
});
