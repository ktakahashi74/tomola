import { expect, test } from "@playwright/test";
import { openVillageMembership, captureScreenshot, enMessages as m, formatMessage, state, uiMessages, useMember, waitForClientRoute } from "./helpers";
import { CHAT_CONSENT_VERSION } from "../app/lib/village-chat-consent";

test("current chat consent protects version-one readers and must be renewed after leaving and rejoining", async ({ page, browser }) => {
  await useMember(page, "ccn_owner@example.com");
  await page.goto("/v/chat-consent/chat"); await waitForClientRoute(page);
  const privacyAvailable = (await page.request.get("/privacy")).ok();
  await expect(page.getByRole("heading", { name: m.village_chat_consent_title, exact: true })).toBeVisible();
  const notice = page.getByRole("region", { name: m.village_chat_consent_title });
  const details = notice.locator("details");
  await expect(details).not.toHaveAttribute("open");
  await expect(notice.getByRole("heading", { name: m.village_chat_changes_title, exact: true })).toBeVisible();
  await expect(notice.locator("#chat-consent-changes + ul").getByRole("listitem")).toHaveText([
    m.village_chat_changes_v2_readers, m.village_chat_changes_v2_review, m.village_chat_changes_v2_spam, m.village_chat_changes_v3_provider, m.chat_consent_v4_replies, m.chat_consent_v4_nushi,
  ]);
  for (const key of ["village_chat_summary_readers", "village_chat_summary_translation", "village_chat_summary_reports"] as const) await expect(notice.getByText(m[key], { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: m.village_chat_consent_accept, exact: true })).toHaveCount(1);
  await expect(details.getByRole("button")).toHaveCount(0);
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.getByRole("listitem")).toHaveCount(privacyAvailable ? 12 : 11);
  await expect(notice.getByText(m.village_chat_consent_readers, { exact: true })).toBeVisible();
  await expect(notice.getByText(formatMessage(m.village_chat_consent_translation, { count: 2 }), { exact: true })).toBeVisible();
  await expect(notice.getByText(formatMessage(m.village_chat_consent_review, { count: 40 }), { exact: true })).toBeVisible();
  await expect(notice.getByText(formatMessage(m.village_chat_consent_retention, { days: 180 }), { exact: true })).toBeVisible();
  await expect(notice.getByText(m.village_chat_consent_ai_review, { exact: true })).toBeVisible();
  await expect(notice.getByText(m.village_chat_consent_spam, { exact: true })).toBeVisible();
  const providerText = formatMessage(m.village_chat_consent_provider, { privacy: m.village_chat_consent_privacy_link });
  const provider = details.getByRole("listitem").filter({ hasText: providerText });
  await expect(provider).toHaveText(providerText);
  await expect(provider.getByRole("link", { name: m.village_chat_consent_privacy_link, exact: true })).toHaveCount(privacyAvailable ? 1 : 0);
  await expect(notice.getByRole("link", { name: m.village_chat_consent_privacy_link, exact: true })).toHaveCount(privacyAvailable ? 3 : 0);
  await expect(page.locator('input[name="version"]')).toHaveValue(String(CHAT_CONSENT_VERSION));
  await expect(page.getByRole("link", { name: m.village_chat_own_title, exact: true })).toHaveAttribute("href", "/settings/chat");
  await expect(page.getByRole("log")).toHaveCount(0);
  const stale = await page.request.post("/v/chat-consent/chat", { form: { intent: "consent", version: "1" }, headers: { Origin: new URL(page.url()).origin } });
  expect(stale.status()).toBe(400);
  const staleHtml = await stale.text(); expect(staleHtml).toContain(m.village_chat_consent_changed);
  expect(staleHtml).not.toContain(m.signing_changed);
  await expect(page.getByText("Consent-protected history", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveCount(0);
  for (const resource of ["changes?since=0", "events"]) expect((await page.request.get(`/v/chat-consent/chat/${resource}`)).status()).toBe(404);
  const denied = await page.request.post("/v/chat-consent/chat", { form: { intent: "send", body: "Old consent must not publish" }, headers: { Origin: new URL(page.url()).origin } });
  expect(denied.status()).toBe(404);
  await page.getByRole("button", { name: m.village_chat_consent_accept, exact: true }).click();
  await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: "Consent-protected history" })).toBeVisible();
  await page.getByLabel(m.village_chat_body, { exact: true }).fill("A consented message");
  await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
  await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: "A consented message" })).toBeVisible();
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const member = await context.newPage(); await useMember(member, "ccn_member@example.com");
    await member.goto("/v/chat-consent/chat"); await waitForClientRoute(member);
    await expect(member.getByRole("heading", { name: m.village_chat_changes_title, exact: true })).toHaveCount(0);
    await expect(member.getByRole("region", { name: m.village_chat_consent_title }).locator("details")).not.toHaveAttribute("open");
    await expect(member.getByText(m.village_chat_summary_readers, { exact: true })).toBeVisible();
    await expect(member.getByRole("log")).toHaveCount(0);
    await expect(member.getByText("A consented message", { exact: true })).toHaveCount(0);
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("Before agreement @ccn_member");
    const candidates = await page.request.get("/mentions/suggest?q=ccn_&village=chat-consent");
    expect(await candidates.json()).toEqual({ handles: [] });
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    await member.goto("/notifications"); await waitForClientRoute(member);
    await expect(member.getByRole("link", { name: formatMessage(m.notification_chat_authors, { name: "chat-consent", handles: "@ccn_owner" }), exact: true })).toHaveCount(0);
    await member.goto("/v/chat-consent/chat"); await waitForClientRoute(member);
    await member.getByRole("button", { name: m.village_chat_consent_accept, exact: true }).click();
    await expect(member.getByRole("log").getByRole("paragraph").filter({ hasText: "A consented message" })).toBeVisible();
    expect(await (await page.request.get("/mentions/suggest?q=ccn_&village=chat-consent")).json()).toEqual({ handles: ["ccn_member"], names: { ccn_member: { displayName: null, displayNameLatin: null, label: null } } });
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("After agreement @ccn_member");
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    await member.goto("/notifications"); await waitForClientRoute(member);
    await expect(member.getByRole("link", { name: formatMessage(m.notification_chat_authors, { name: "chat-consent", handles: "@ccn_owner" }), exact: true })).toHaveCount(1);
    await member.goto("/v/chat-consent"); await waitForClientRoute(member);
    await openVillageMembership(member);
    await member.getByRole("button", { name: m.village_leave, exact: true }).click();
    await expect(member.getByRole("button", { name: m.village_join, exact: true })).toBeVisible();
    await member.getByRole("button", { name: m.village_join, exact: true }).click();
    await expect(member.locator("[data-village-header] summary").filter({ hasText: m.village_joined })).toBeVisible();
    await waitForClientRoute(member);
    await member.getByRole("link", { name: m.village_chat_title, exact: true }).click();
    await expect(member).toHaveURL(/\/v\/chat-consent\/chat$/);
    await expect(member.getByRole("button", { name: m.village_chat_consent_accept, exact: true })).toBeVisible();
    await expect(member.getByRole("log")).toHaveCount(0);
  } finally { await context.close(); }
});

test("version-two members see provider and reply-context changes and can use chat after renewing consent", async ({ page }) => {
  await useMember(page, "ccn_v2@example.com");
  await page.setViewportSize({ width: 390, height: 900 });
  for (const lang of ["ja", "en"]) {
    await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: lang, url: state().baseURL }]);
    await page.goto(`/v/chat-consent-v2/chat?lang=${lang}`); await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    const messages = await uiMessages(page);
    const notice = page.getByRole("region", { name: messages.village_chat_consent_title });
    await expect(notice.locator("#chat-consent-changes + ul").getByRole("listitem")).toHaveText([messages.village_chat_changes_v3_provider, messages.chat_consent_v4_replies, messages.chat_consent_v4_nushi]);
    await expect(page.getByRole("log")).toHaveCount(0);
    await notice.locator("summary").click();
    await expect(notice.getByText(formatMessage(messages.village_chat_consent_provider, { privacy: messages.village_chat_consent_privacy_link }), { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.E2E_EVIDENCE_DIR) {
      await page.evaluate(() => document.fonts.ready);
      await captureScreenshot(page, { path: `provider-consent-${lang}-390.png`, fullPage: true }, ".");
    }
  }
  const stale = await page.request.post("/v/chat-consent-v2/chat", { form: { intent: "consent", version: "2" }, headers: { Origin: new URL(page.url()).origin } });
  expect(stale.status()).toBe(400);
  expect(await stale.text()).toContain(m.village_chat_consent_changed);
  await page.getByRole("button", { name: m.village_chat_consent_accept, exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Consent-protected history");
  await page.getByLabel(m.village_chat_body, { exact: true }).fill("Renewed provider consent");
  await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Renewed provider consent");
  await page.goto("/v/chat-consent-v2/chat"); await waitForClientRoute(page);
  await expect(page.getByRole("log")).toBeVisible();
  await expect(page.getByRole("button", { name: m.village_chat_consent_accept, exact: true })).toHaveCount(0);
});

test("chat consent works without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US" });
  try {
    const page = await context.newPage(); await useMember(page, "ccn_nojs@example.com");
    await page.goto("/v/chat-consent-nojs/chat");
    await expect(page.getByRole("log")).toHaveCount(0);
    await page.getByRole("button", { name: m.village_chat_consent_accept, exact: true }).click();
    await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: "Consent-protected history" })).toBeVisible();
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("Consent without script");
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: "Consent without script" })).toBeVisible();
  } finally { await context.close(); }
});
