import { formatOperatorCopy, operatorCopy } from "~/lib/operator-settings";
import { testOperator } from "./helpers/operator";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ChatConsentNotice } from "~/components/chat-consent-notice";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";
import { setTestLocale } from "./stubs/paraglide-runtime";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
// Different policy values catch numbers that have been copied into the wording.
vi.mock("~/lib/chat-access", () => ({ CHAT_CASE_CONTEXT_COUNT: 7, CHAT_CASE_EXPAND_LIMIT: 2, CHAT_REPORT_RETAIN_DAYS: 93 }));
vi.mock("~/lib/village-chat", () => ({ CHAT_TRANSLATION_CONTEXT_COUNT: 5 }));
afterEach(() => setTestLocale("en"));

it.each(["en", "ja"] as const)("derives all disclosed counts from policy constants in %s", async locale => {
  setTestLocale(locale);
  const html = await renderInRouter(() => createElement(ChatConsentNotice, { privacyAvailable: true, previousVersion: null }), "/consent");
  expect(html).toContain(renderToStaticMarkup(createElement("span", null, m.village_chat_consent_translation({ count: 5 }))));
  const providerText = formatOperatorCopy(operatorCopy(testOperator, locale).chatProvider, { privacy: m.village_chat_consent_privacy_link() });
  expect(html.replace(/<a\b[^>]*>|<\/a>/g, "")).toContain(renderToStaticMarkup(createElement("li", null, providerText)));
  expect(html).toContain(renderToStaticMarkup(createElement("li", null, m.village_chat_consent_ai_review())));
  expect(html).toContain(locale === "ja" ? "それぞれ最大 21 件" : "up to 21 before and 21 after");
  expect(html).toContain(locale === "ja" ? "処理の後 93 日" : "kept for 93 days");
  expect(html).toContain(locale === "ja" ? "通報された発言の写しは" : "A copy of a reported message is kept");
  expect(html).toContain(locale === "ja" ? "消された発言は読みません" : "deleted messages are not read");
  expect(html).not.toContain(locale === "ja" ? "通報された発言と前後の写し" : "A copy of a reported message and the messages around it");
  const details = html.match(/<details\b([^>]*)>([\s\S]*?)<\/details>/)!;
  expect(details[1]).not.toMatch(/\bopen\b/);
  expect(details[2].match(/<li[ >]/g)).toHaveLength(12);
  expect(html.match(/<li[ >]/g)).toHaveLength(15);
  expect(html.slice(0, html.indexOf("<details"))).toContain(m.village_chat_summary_reports());
  expect(html).toContain(m.village_chat_read_full());
  expect(html).not.toContain('id="chat-consent-changes"');
  expect(html).toContain('href="/privacy"');
  expect(html).not.toMatch(/\{(?:count|days|ownMessages|privacy)\}/);
  expect(html).not.toContain("offshore_report_america");
});

it.each(["en", "ja"] as const)("links the provider disclosure only when privacy is available, retaining its text in %s", async locale => {
  setTestLocale(locale);
  const text = formatOperatorCopy(operatorCopy(testOperator, locale).chatProvider, { privacy: m.village_chat_consent_privacy_link() });
  const expected = renderToStaticMarkup(createElement("li", null, text));
  for (const privacyAvailable of [true, false]) {
    const html = await renderInRouter(() => createElement(ChatConsentNotice, { privacyAvailable, previousVersion: null }));
    const provider = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(match => match[0])
      .find(item => item.replace(/<a\b[^>]*>|<\/a>/g, "") === expected);
    expect(provider).toBeDefined();
    expect(provider!.includes('href="/privacy"')).toBe(privacyAvailable);
    expect(html.match(/href="\/privacy"/g) ?? []).toHaveLength(privacyAvailable ? 3 : 0);
  }
});

it.each(["en", "ja"] as const)("shows versioned changes above the summary only for a previous agreement in %s", async locale => {
  setTestLocale(locale);
  const { chatConsentChanges } = await import("~/lib/chat-consent-changes");
  for (const previousVersion of [null, 0, ...Array.from({ length: CHAT_CONSENT_VERSION }, (_, i) => i + 1)]) {
    const html = await renderInRouter(() => createElement(ChatConsentNotice, { privacyAvailable: false, previousVersion }));
    const changes = chatConsentChanges(previousVersion, operatorCopy(testOperator, locale).chatProviderChange);
    expect(html.includes('id="chat-consent-changes"')).toBe(previousVersion !== null && previousVersion > 0 && previousVersion < CHAT_CONSENT_VERSION);
    const expected = previousVersion === 1
      ? [m.village_chat_changes_v2_readers(), m.village_chat_changes_v2_review(), m.village_chat_changes_v2_spam(), operatorCopy(testOperator, locale).chatProviderChange]
      : previousVersion === 2 ? [operatorCopy(testOperator, locale).chatProviderChange] : [];
    expect(changes).toEqual([...expected, ...(previousVersion !== null && previousVersion > 0 && previousVersion < CHAT_CONSENT_VERSION ? [m.chat_consent_v4_replies(), m.chat_consent_v4_nushi()] : [])]);
    if (changes.length) expect(html.indexOf('id="chat-consent-changes"')).toBeLessThan(html.indexOf(m.village_chat_summary_readers()));
    expect(html.match(/<li[ >]/g)).toHaveLength(14 + changes.length);
  }
});

it("uses another operator's provider policy and change history without changing the consent version", async () => {
  const settings = structuredClone(testOperator);
  settings.copy.en.chatProvider = "Our chosen provider policy is described in the {privacy}.";
  settings.copy.en.chatProviderChange = "Our provider policy was updated.";
  const html = await renderInRouter(() => createElement(ChatConsentNotice, { privacyAvailable: true, previousVersion: 2 }), "/consent", undefined, { operator: settings });
  expect(html).toContain(settings.copy.en.chatProviderChange);
  expect(html.replace(/<a\b[^>]*>|<\/a>/g, "")).toContain(formatOperatorCopy(settings.copy.en.chatProvider, { privacy: m.village_chat_consent_privacy_link() }));
  expect(html).not.toContain(testOperator.copy.en.chatProviderChange);
});

it.each(["en", "ja"] as const)("keeps consent and its change history identical across the chat AI switch in %s", async locale => {
  setTestLocale(locale);
  const rendered: string[] = [];
  for (const flag of ["0", "1"]) {
    vi.stubEnv("VILLAGE_CHAT_NUSHI", flag);
    const html = await renderInRouter(() => createElement(ChatConsentNotice, { privacyAvailable: true, previousVersion: CHAT_CONSENT_VERSION - 1 }));
    for (const text of [m.chat_consent_nushi(), m.chat_consent_nushi_hide(), m.chat_consent_v4_nushi()]) expect(html).toContain(text);
    rendered.push(html);
  }
  vi.unstubAllEnvs();
  expect(rendered[0]).toBe(rendered[1]);
});
