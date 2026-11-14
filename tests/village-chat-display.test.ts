import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { renderInRouter } from "./helpers/render-in-router";
import VillageChat from "~/routes/village-chat";
import type { ActiveChatMessage } from "~/lib/village-chat";
import { m } from "~/paraglide/messages.js";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { setTestLocale } from "./stubs/paraglide-runtime";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it.each(["en", "ja"] as const)("shows the current consent as separate disclosures in %s", async locale => {
  setTestLocale(locale);
  try {
    const html = await render("", false, { consentRequired: true, consentVersion: CHAT_CONSENT_VERSION, previousConsentVersion: null, privacyAvailable: false });
    expect(html).toContain(m.village_chat_consent_title());
    expect(html).toMatch(/<details(?![^>]*\bopen)[^>]*>/);
    expect(html).not.toContain('id="chat-consent-changes"');
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf('value="consent"'));
    expect(html.match(/<li[ >]/g)).toHaveLength(14);
    expect(html).toContain(m.chat_consent_nushi());
    expect(html).toContain(m.chat_consent_nushi_hide());
    expect(html).not.toContain("offshore_report_america");
    expect(html).toContain('href="/settings/chat"');
    expect(html).not.toContain('href="/privacy"');
    expect(html).not.toContain('role="log"');
    expect(html).toContain(`name="version" value="${CHAT_CONSENT_VERSION}"`);
  } finally { setTestLocale("en"); }
});

const original = "Original chat text";
async function render(errorCode: string, historical = false, overrides: Record<string, unknown> = {}) {
  const message: ActiveChatMessage = { id: "a".repeat(32), author: "display_writer", own: false, lang: "ja", parts: [{ type: "text", text: original }], createdSeq: 1, changedSeq: 1, createdAt: "2026-10-15T00:00:00Z", edited: false, deleted: false, hidden: false, translation: { text: null, lang: "en", state: "failed", errorCode } };
  const loaderData = { readers: 2, village: { slug: "display-chat", name: "Display chat" }, messages: [message], seq: 2, ended: false, historical, hasNewer: true, readSeq: 0, consentRequired: false, linkLang: null, before: null, unreadCounts: {}, report: null, reported: null, now: Date.parse("2026-10-16T00:00:00Z"), window: "", latest: false, unreadAfter: 0, ...overrides };
  return renderInRouter(() => createElement(VillageChat, { loaderData } as never), "/v/display-chat/chat");
}
it.each(["untranslated_script", "untranslated_similar"])("renders %s as source text without a failure notice", async reason => {
  const html = await render(reason);
  expect(html).toContain(original); expect(html).toContain('lang="ja"');
  expect(html).not.toContain(m.village_chat_translation_failed());
  expect(html).not.toContain(m.village_chat_translation_machine());
});
it.each(["invalid_output", "engine", "recovery_limit", "untranslated"])("keeps the failure notice for %s", async reason => {
  expect(await render(reason)).toContain(m.village_chat_translation_failed());
});
it("offers the latest destination in both historical and live windows without eager report forms", async () => {
  for (const historical of [true, false]) {
    const html = await render("engine", historical);
    expect(html).toContain(m.village_chat_latest());
    expect(html).toContain('/v/display-chat/chat?latest=1#chat-bottom');
    expect(html).not.toContain('name="reason"');
    expect(html).toContain('/v/display-chat/chat?report=');
  }
});

it("offers a latest exit from an empty continuation and preserves only the reading language on paging links", async () => {
  const empty = await render("engine", true, { messages: [], hasNewer: false, window: "::999" });
  expect(empty).toContain('/v/display-chat/chat?latest=1#chat-bottom');
  const html = await render("engine", true, { linkLang: "ja", before: 1 });
  expect(html).toContain('?before=1&amp;lang=ja');
  expect(html).toContain('?after=1&amp;lang=ja');
});

it("caps the continuation indicator at the existing 99+ display", async () => {
  expect(await render("engine", true, { unreadAfter: 100 })).toContain(m.village_chat_new_messages({ count: "99+" }));
});
