import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, state, useMember, waitForClientRoute } from "./helpers";

test.use({ actionTimeout: 20_000 });

// Every identity belongs only to this scenario.
test("chat AI keeps private access, explicit calls, quiet arrivals and ordinary replies", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.231"));
  const path = "/v/chat-nushi-browser/chat?lang=en";
  if (!info.config.metadata.publicReading) {
    expect((await page.request.post("/v/chat-nushi-browser/chat/nushi", { form: { body: "@nushi orchard" } })).status()).toBe(404);
    return;
  }
  await useMember(page, "zcn_flow_caller@example.com", path); await waitForClientRoute(page);
  const enabled = process.env.E2E_CHAT_NUSHI === "1";
  const consent = page.getByRole("region", { name: en.village_chat_consent_title });
  await consent.locator("summary").click();
  await expect(consent.getByRole("listitem").filter({ hasText: en.chat_consent_nushi })).toHaveCount(1);
  await expect(consent.getByText(en.chat_consent_nushi_hide, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: en.village_chat_consent_accept, exact: true }).click();
  await expect(page.getByRole("log")).toBeVisible();
  const field = page.getByLabel(en.village_chat_body, { exact: true });
  await expect(field.locator("xpath=ancestor::form")).toHaveClass(enabled ? /\bflex-wrap\b/ : /^(?!.*\bflex-wrap\b).*$/);
  await field.fill("@nushi orchard");
  if (!enabled) {
    await expect(page.getByText(en.chat_nushi_call_notice, { exact: true })).toHaveCount(0);
    expect((await page.request.post("/v/chat-nushi-browser/chat/nushi", { form: { body: "@nushi orchard" } })).status()).toBe(404);
    return;
  }
  await expect(page.getByText(en.chat_nushi_call_notice, { exact: true })).toBeVisible();
  await expect(page.locator('input[name="suppressNushi"]')).toHaveCount(0);
  const readerContext = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block", locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.232") });
  const reader = await readerContext.newPage();
  await useMember(reader, "zcn_flow_reader@example.com", path); await waitForClientRoute(reader);
  await reader.getByRole("button", { name: en.village_chat_consent_accept, exact: true }).click();
  await expect(reader.getByRole("log")).toBeVisible();
  let releaseAI = false;
  await reader.route("**/chat/changes?*", async route => {
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const data = await response.json();
    const ai = data.messages?.filter((message: { nushi?: unknown }) => !!message.nushi) ?? [];
    if (!releaseAI && ai.length) {
      data.messages = data.messages.filter((message: { nushi?: unknown }) => !message.nushi);
      data.next = Math.min(data.next, ...ai.map((message: { changedSeq: number }) => message.changedSeq - 1));
    }
    await route.fulfill({ response, json: data });
  });
  await field.fill("@nushi orchard planting date");
  await expect(page.getByText(en.chat_nushi_call_notice, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: en.village_chat_send, exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(page.locator("[data-chat-nushi]")).toHaveCount(1, { timeout: 120_000 });
  await expect(reader.getByRole("log")).toContainText("@nushi orchard planting date");
  await reader.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrollBeforeAI = await reader.evaluate(() => window.scrollY);
  releaseAI = true;
  await reader.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(reader.locator("[data-chat-nushi]")).toHaveCount(1);
  expect(await reader.evaluate(() => window.scrollY)).toBeCloseTo(scrollBeforeAI, 0);
  await expect(reader.locator("[data-chat-nushi]")).toHaveAttribute("aria-live", "polite");
  await expect(reader.locator("[data-chat-nushi] [data-chat-read-seq]")).toHaveCount(0);
  await readerContext.close();
  const answer = page.locator("[data-chat-nushi]");
  await expect(answer).toContainText("zcn_flow_caller");
  if (await answer.locator("details").count()) await answer.locator("details > summary").first().click();
  await expect(answer).toContainText("zcn_flow_owner");
  await expect(answer.locator("[data-chat-reply]")).toContainText("@nushi orchard planting date");
  await expect(answer.locator("[data-chat-read-seq]")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const guest = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const outsider = await guest.newPage(); await outsider.goto(page.url());
    await expect(outsider.locator("[data-chat-nushi]")).toHaveCount(0);
    expect((await outsider.request.get("/v/chat-nushi-browser/chat/changes?since=0")).status()).toBe(401);
  } finally { await guest.close(); }
  await answer.locator('[id^="chat-byline-"]').click(); await answer.getByRole("button", { name: en.village_chat_reply, exact: true }).click();
  await field.fill("A human reply to the source guide");
  await page.getByRole("button", { name: en.village_chat_send, exact: true }).click();
  await expect(page.getByRole("log")).toContainText("A human reply to the source guide");
  await answer.locator('[id^="chat-byline-"]').click(); await answer.getByRole("link", { name: en.chat_reports_flag, exact: true }).click();
  await page.getByRole("dialog", { name: en.chat_reports_flag, exact: true }).getByRole("button", { name: en.flag_submit, exact: true }).click();
  await expect(page.getByText(en.chat_reports_flagged, { exact: true })).toBeVisible();
  const moderatorContext = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block", locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.233") });
  try {
    const moderator = await moderatorContext.newPage();
    await useMember(moderator, "zcn_flow_mod@example.com", "/mod"); await waitForClientRoute(moderator);
    await expect(moderator.locator("main")).not.toContainText("This post contains the following passage.");
    await moderator.locator("section").filter({ hasText: "Chat AI browser village" }).getByRole("link", { name: en.chat_reports_open, exact: true }).click();
    await waitForClientRoute(moderator);
    await expect(moderator.locator("main")).not.toContainText("This post contains the following passage.");
    await moderator.getByRole("button", { name: en.chat_reports_open, exact: true }).click();
    await expect(moderator.locator("main")).toContainText("This post contains the following passage.");
    await expect(moderator.locator("main")).toContainText("@nushi orchard planting date");
    await moderator.getByLabel(en.mod_note, { exact: true }).fill("The AI source guide is under review.");
    await moderator.getByRole("button", { name: en.chat_reports_hide, exact: true }).click();
    await expect(moderator.getByText(en.chat_reports_done, { exact: true })).toBeVisible();
    await expect(answer).toContainText(en.nushi_hidden);
  } finally { await moderatorContext.close(); }
});
