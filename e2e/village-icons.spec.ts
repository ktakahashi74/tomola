import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { largeUpload, uploadResponse } from "./large-upload";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { House, MapPinHouse, UsersRound } from "lucide-react";
import { captureScreenshot, enMessages as en, state, uiMessages, useMember, visitListRow, waitForHydration } from "./helpers";

for (const locale of ["ja", "en"] as const) test(`village icons in headers, places, chat and owner controls (${locale})`, async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
  await useMember(page, `vi_view_${locale}@example.com`, `/v/icons-view?lang=${locale}`);
  const icon = page.locator('[data-village-header] h1 img');
  await expect(icon).toHaveAttribute("alt", "");
  const image = await icon.getAttribute("src");
  await expect(page.locator("#village-icon-settings")).toHaveCount(0);
  const personal = page.locator('[data-site-navigation] a[href="/u/vi_owner"] img');
  await expect(personal).toHaveAttribute("src", /\/media\//);
  const memberImage = await personal.getAttribute("src");
  const language = page.locator('[data-site-navigation] a[href="/v/en"] img');
  await expect(language).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  await expect(page.locator('[data-site-navigation] a[href="/v/icons-view"] img')).toHaveAttribute("src", image!);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `header-places-${locale}-${width}.png`, fullPage: true }, "village-icons");
    if (width === 390) {
      await waitForHydration(page);
      const drawer = page.locator("[data-navigation-drawer]:visible");
      await drawer.locator(":scope > summary").click();
      await expect(drawer.locator('a[href="/v/icons-view"] img')).toHaveAttribute("src", image!);
      await captureScreenshot(page, { path: `drawer-${locale}-${width}.png`, fullPage: true }, "village-icons");
      await page.keyboard.press("Escape");
    }
    await page.goto(`/v/icons-view/chat?lang=${locale}`);
    await expect(page.locator('[data-village-header] h1 img')).toHaveAttribute("src", image!);
    await captureScreenshot(page, { path: `chat-${locale}-${width}.png`, fullPage: true }, "village-icons");
    await page.goto(`/v/icons-view?lang=${locale}`);
  }
  await page.goto(`/u/vi_owner?lang=${locale}`);
  await expect(page.locator("h1 img")).toHaveAttribute("src", memberImage!);
  await useMember(page, "vi_coowner@example.com", `/v/icons-view?manage=1&lang=${locale}`);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("#village-icon-settings img")).toHaveAttribute("src", image!);
    await expect(page.locator("#village-icon-settings").getByRole("heading", { name: (await uiMessages(page)).village_icon_label, exact: true })).toBeVisible();
    await captureScreenshot(page, { path: `management-${locale}-${width}.png`, fullPage: true }, "village-icons");
  }
  await page.goto(`/v/en?lang=${locale}`);
  await expect(page.locator("#village-icon-settings")).toHaveCount(0);
  await expect(page.locator('[data-village-header] h1 img')).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  const markdown = await page.request.get("/v/icons-view.md");
  expect(await markdown.text()).not.toContain(image!);

  if (locale === "ja" && process.env.E2E_EVIDENCE_DIR) {
    const candidates = [["House", House], ["UsersRound", UsersRound], ["MapPinHouse", MapPinHouse]] as const;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setContent(`<html lang="ja"><meta charset="utf-8"><style>body{font:16px system-ui;margin:32px;color:#171717;background:white}main{display:flex;gap:32px}section{border:1px solid #ddd;padding:24px;width:300px}h1{font-size:24px;display:flex;align-items:center;gap:12px}.row{display:flex;gap:8px;align-items:center;margin:24px 0}svg{flex-shrink:0}h2{font-size:16px}</style><body><h1>ビレッジ記号の比較</h1><main>${candidates.map(([name, component]) => `<section><h2>${name}</h2><h1>${renderToStaticMarkup(createElement(component, { size: 32 }))}集まりのビレッジ</h1><div class="row">${renderToStaticMarkup(createElement(component, { size: 20 }))}集まりのビレッジ</div><div class="row">${renderToStaticMarkup(createElement(component, { size: 20 }))}話題を読む会</div></section>`).join("")}</main></body></html>`);
    await captureScreenshot(page, { path: "symbol-candidates.png", fullPage: true }, "village-icons");
  }
});

test("village owners upload and reset an image, then report, removal and independent appeal restore it", async ({ page }) => {
  await useMember(page, "vi_owner@example.com", "/v/icons-journey?manage=1&lang=en"); await waitForHydration(page);
  const settings = page.locator("#village-icon-settings");
  const fallback = await settings.locator("img").getAttribute("src");
  const picture = { name: "logo.jpg", mimeType: "image/jpeg", buffer: await sharp({ create: { width: 60, height: 90, channels: 3, background: "#737373" } }).withExif({ IFD0: { Artist: "Private camera" } }).jpeg().toBuffer() };
  const uploadedResponse = uploadResponse(page, "/v/icons-journey/icon");
  await settings.locator('input[type="file"]').setInputFiles(await largeUpload());
  await uploadedResponse;
  await expect(settings.getByRole("status")).toHaveText(en.settings_saved);
  const first = (await settings.locator("img").getAttribute("src"))!;
  await useMember(page, "vi_coowner@example.com", "/v/icons-journey?manage=1&lang=en"); await waitForHydration(page);
  await settings.getByRole("button", { name: en.village_icon_reset, exact: true }).click();
  await expect(settings.locator("img")).toHaveAttribute("src", fallback!);
  expect((await page.request.get(first)).status()).toBe(404);
  await settings.locator('input[type="file"]').setInputFiles(picture);
  await expect(settings.getByRole("status")).toHaveText(en.settings_saved);
  const uploaded = (await settings.locator("img").getAttribute("src"))!;
  const downloaded = await page.request.get(uploaded);
  const metadata = await sharp(await downloaded.body()).metadata();
  expect(metadata).toMatchObject({ width: 256, height: 256 });
  expect(metadata.exif).toBeUndefined();
  await useMember(page, "vi_reporter@example.com", "/v/icons-journey?lang=en"); await waitForHydration(page);
  await expect(settings).toHaveCount(0);
  expect((await page.request.post("/v/icons-journey/icon", { form: { intent: "reset" }, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(403);
  await page.getByText(en.village_report, { exact: true }).click();
  await page.getByRole("combobox", { name: en.village_report_target, exact: true }).selectOption("information");
  await page.getByLabel(en.flag_note, { exact: true }).fill("Review this village name");
  await page.getByRole("button", { name: en.flag_submit, exact: true }).click();
  await expect(page.getByText(en.village_reported, { exact: true })).toBeVisible();
  await page.reload(); await waitForHydration(page);
  await page.getByText(en.village_report, { exact: true }).click();
  await expect(page.getByRole("combobox", { name: en.village_report_target, exact: true }).locator("option")).toHaveCount(1);
  await page.getByRole("combobox", { name: en.village_report_target, exact: true }).selectOption("icon");
  await page.getByLabel(en.flag_note, { exact: true }).fill("Review this village icon");
  await page.getByRole("button", { name: en.flag_submit, exact: true }).click();
  await expect(page.getByText(en.village_reported, { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: en.village_report_target, exact: true })).toHaveCount(0);
  await useMember(page, "vi_operator@example.com", "/mod?lang=en"); await waitForHydration(page);
  const card = page.locator('section[id^="v-report-"]').filter({ has: page.locator('a[href="/v/icons-journey"]') });
  await visitListRow(page, "/mod?lang=en", card); await waitForHydration(page);
  const informationReport = card.locator("li").filter({ hasText: "Review this village name" });
  await expect(informationReport).toContainText(en.village_report_information);
  await expect(informationReport.locator("img")).toHaveCount(0);
  const iconReport = card.locator("li").filter({ hasText: "Review this village icon" });
  await expect(iconReport).toContainText(en.village_icon_label);
  await expect(iconReport.locator("img")).toHaveAttribute("src", uploaded);
  await card.getByLabel(en.village_mod_note, { exact: true }).fill("Image removed for review");
  await card.getByRole("button", { name: en.village_icon_clear, exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.goto("/v/icons-journey?lang=en");
  await expect(page.locator('[data-village-header] h1 img')).toHaveAttribute("src", fallback!);
  expect((await page.request.get(uploaded)).status()).toBe(200);
  await useMember(page, "vi_coowner@example.com", "/notifications?lang=en"); await waitForHydration(page);
  await page.getByRole("link", { name: en.notification_appeal, exact: true }).click();
  await expect(page.locator("main img")).toHaveAttribute("src", uploaded);
  await page.getByLabel(en.appeal_text, { exact: true }).fill("Please review the village logo");
  await page.getByRole("button", { name: en.appeal_submit, exact: true }).click();
  await expect(page.getByText(en.appeal_status_open, { exact: true })).toBeVisible();
  await useMember(page, "vi_reviewer@example.com", "/mod/appeals?lang=en"); await waitForHydration(page);
  const appeal = page.locator('section[id^="a-"]').filter({ has: page.locator(`img[src="${uploaded}"]`) });
  await visitListRow(page, "/mod/appeals?lang=en", appeal); await waitForHydration(page);
  await appeal.getByLabel(en.mod_appeals_note, { exact: true }).fill("The logo is allowed");
  await appeal.getByRole("button", { name: en.mod_appeals_overturn, exact: true }).click();
  await expect(appeal).toHaveCount(0);
  await page.goto("/v/icons-journey?lang=en");
  await expect(page.locator('[data-village-header] h1 img')).toHaveAttribute("src", uploaded);
});
