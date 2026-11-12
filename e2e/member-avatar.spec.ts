import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { largeUpload, uploadResponse } from "./large-upload";
import { captureScreenshot, useMember, enMessages as en, jaMessages as ja, state, waitForHydration } from "./helpers";

const picture = async () => ({ name: "portrait.png", mimeType: "image/png", buffer: await sharp({ create: { width: 72, height: 48, channels: 3, background: "#789" } }).png().toBuffer() });

for (const lang of ["en", "ja"]) test(`avatar presentation on member pages, bylines and chat (${lang})`, async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: lang, url: state().baseURL }]);
  await useMember(page, "av_writer@example.com", `/settings?lang=${lang}`);
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, url] of [["settings", `/settings?lang=${lang}`], ["member", `/u/av_writer?lang=${lang}`]]) {
      await page.goto(url);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator(name === "settings" ? "#settings-avatar img" : "h1 img")).toHaveAttribute("alt", "");
      await captureScreenshot(page, { path: `${name}-${lang}-${width}.png`, fullPage: true }, "member-avatar");
    }
    const article = page.locator(".topic-row .topic-title");
    await expect(article).toHaveCount(1);
    await article.click();
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect(page.locator("#replies")).toBeAttached();
    await expect(page.locator("[data-reading-byline] img")).toHaveCount(0);
    await expect(page.locator('[id^="reply-meta-"] img')).toHaveAttribute("alt", "");
    await captureScreenshot(page, { path: `topic-${lang}-${width}.png`, fullPage: true }, "member-avatar");
    if (test.info().config.metadata.publicReading) {
      await page.goto(`/v/avatar-chat/chat?lang=${lang}`);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator("[data-chat-message]")).toHaveCount(1);
      await expect(page.locator("[data-chat-message] img")).toHaveAttribute("alt", "");
      await captureScreenshot(page, { path: `chat-${lang}-${width}.png`, fullPage: true }, "member-avatar");
    }
  }
});

test("member selects an image, sees it on their page and returns to automatic", async ({ page }) => {
  await useMember(page, "av_settings@example.com", "/settings?lang=en");
  await waitForHydration(page);
  const settings = page.locator("#settings-avatar");
  const automatic = await settings.locator("img").getAttribute("src");
  const uploadedResponse = uploadResponse(page, "/settings/avatar");
  await settings.locator('input[type="file"]').setInputFiles(await largeUpload());
  await uploadedResponse;
  await expect(settings.getByRole("status")).toHaveText(en.settings_saved);
  const uploaded = await settings.locator("img").getAttribute("src");
  expect(uploaded).not.toBe(automatic);
  await expect(settings.getByRole("button", { name: en.avatar_reset, exact: true })).toBeVisible();
  await page.goto("/u/av_settings?lang=en");
  await expect(page.locator("h1 img")).toHaveAttribute("src", uploaded!);
  await page.goto("/?lang=en");
  await expect(page.locator(".topic-row img")).toHaveCount(0);
  await page.goto("/settings?lang=en"); await waitForHydration(page);
  await settings.getByRole("button", { name: en.avatar_reset, exact: true }).click();
  await expect(settings.locator("img")).toHaveAttribute("src", automatic!);
  await expect(settings.getByRole("button", { name: en.avatar_reset, exact: true })).toHaveCount(0);
  expect((await page.request.get(uploaded!)).status()).toBe(404);
});

test("avatar report, operator removal and independent appeal restore the image", async ({ page }) => {
  await useMember(page, "av_subject@example.com", "/settings?lang=en"); await waitForHydration(page);
  await page.locator('#settings-avatar input[type="file"]').setInputFiles(await picture());
  await expect(page.locator("#settings-avatar [role=status]")).toHaveText(en.settings_saved);
  const uploaded = (await page.locator("#settings-avatar img").getAttribute("src"))!;
  await useMember(page, "av_reporter@example.com", "/u/av_subject?lang=en"); await waitForHydration(page);
  const report = page.locator("details").filter({ has: page.locator("summary", { hasText: en.avatar_report }) });
  await report.locator("summary").click();
  await report.locator('[name="note"]').fill("Avatar report belonging to this scenario");
  await report.getByRole("button", { name: en.flag_submit, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(en.flag_thanks);
  await useMember(page, "av_operator@example.com", "/mod?lang=en"); await waitForHydration(page);
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: "@av_subject", exact: true }) });
  await expect(card.locator("img")).toHaveCount(2);
  await card.locator('[name="note"]').fill("Picture removed for review");
  await card.getByRole("button", { name: en.avatar_clear, exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.goto("/moderation?lang=en");
  await expect(page.getByText(en.log_avatar_removed, { exact: true })).toBeVisible();
  await useMember(page, "av_subject@example.com", "/notifications?lang=en"); await waitForHydration(page);
  const appealLink = page.getByRole("link", { name: en.notification_appeal, exact: true });
  await appealLink.first().click();
  await expect(page.getByText(en.log_avatar_removed, { exact: true })).toBeVisible();
  await expect(page.locator("main img")).toHaveAttribute("src", uploaded);
  const appealUrl = page.url();
  await page.locator('[name="text"]').fill("This is my image; please review");
  await page.getByRole("button", { name: en.appeal_submit, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(en.appeal_sent);
  await captureScreenshot(page, { path: "appeal.png", fullPage: true }, "member-avatar");
  await useMember(page, "av_reviewer@example.com", "/mod/appeals?lang=en"); await waitForHydration(page);
  const appeal = page.locator("section").filter({ has: page.locator(`img[src="${uploaded}"]`) });
  await appeal.locator('[name="note"]').fill("The image is allowed");
  await appeal.getByRole("button", { name: en.mod_appeals_overturn, exact: true }).click();
  await expect(appeal).toHaveCount(0);
  await useMember(page, "av_subject@example.com", appealUrl);
  await expect(page.getByText(en.appeal_status_overturned, { exact: true })).toBeVisible();
  await page.goto("/u/av_subject?lang=en");
  await expect(page.locator("h1 img")).toHaveAttribute("src", uploaded);
  for (const [locale, messages] of [["en", en], ["ja", ja]] as const) {
    await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
    await page.goto(`/moderation?lang=${locale}`);
    await expect(page.getByText(messages.log_avatar_restored, { exact: true })).toBeVisible();
    if (process.env.E2E_EVIDENCE_DIR) for (const width of [1280, 1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await captureScreenshot(page, { path: `restored-${locale}-${width}.png`, fullPage: true }, "member-avatar");
    }
  }
});

test("anonymous avatar delivery follows public reading without exposing a member link", async ({ page, browser }) => {
  await useMember(page, "av_public@example.com", "/settings?lang=en"); await waitForHydration(page);
  const automatic = (await page.locator("#settings-avatar img").getAttribute("src"))!;
  await page.locator('#settings-avatar input[type="file"]').setInputFiles(await picture());
  await expect(page.locator("#settings-avatar [role=status]")).toHaveText(en.settings_saved);
  const uploaded = (await page.locator("#settings-avatar img").getAttribute("src"))!;
  const anonymous = await browser.newContext();
  try {
    const expected = test.info().config.metadata.publicReading ? 200 : 404;
    for (const url of [automatic, uploaded]) {
      const response = await anonymous.request.get(new URL(url, page.url()).href);
      expect(response.status()).toBe(expected);
      expect(response.headers()["location"]).toBeUndefined();
      expect(response.headers()["link"]).toBeUndefined();
    }
    const member = await anonymous.request.get(new URL("/u/av_public", page.url()).href, { maxRedirects: 0 });
    expect(member.status()).toBe(302);
  } finally { await anonymous.close(); }
});
