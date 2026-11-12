import { expect, test } from "@playwright/test";
import { captureScreenshot, chooseEditorMode, enMessages as en, jaMessages as ja, formatMessage, openPlaces, openUserMenu, state, useMember, waitForHydration } from "./helpers";

test("display name screen evidence", async ({ page }) => {
  test.skip(!process.env.E2E_EVIDENCE_DIR, "Screenshots need an evidence destination");
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [email, locale, label] of [
      ["dn_han_author@example.com", "ja", "settings-ja"],
      ["dn_single@example.com", "en", "settings-en"],
      ["dn_han_author@example.com", "zh-Hans", "settings-zh"],
    ]) {
      await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
      await useMember(page, email, `/settings?lang=${locale}#settings-display-name`);
      await waitForHydration(page);
      await page.locator("#settings-display-name").scrollIntoViewIfNeeded();
      await captureScreenshot(page, { path: `${label}-${width}.png` }, "fields");
    }
    await useMember(page, "dn_reader@example.com", "/u/dn_han_author?lang=zh-Hans");
    await waitForHydration(page);
    await captureScreenshot(page, { path: `member-${width}.png` }, "fields");
    await page.locator('main a[href^="/t/"]').filter({ hasText: "Display name Han article" }).first().click();
    await expect(page).toHaveURL(/\/t\/\d+/);
    await page.goto(`${new URL(page.url()).pathname}?lang=zh-Hans`);
    await waitForHydration(page);
    await expect(page.locator("[data-reading-byline]")).toBeVisible();
    await expect(page.locator("[data-article-signature]")).toBeVisible();
    await captureScreenshot(page, { path: `article-${width}.png`, fullPage: true }, "fields");
  }
});

test("single display name fields preserve a stored Latin-only name and save one name for every screen", async ({ page }) => {
  await useMember(page, "dn_single_save@example.com", "/settings?lang=en#settings-display-name");
  await waitForHydration(page);
  const form = page.locator("#settings-display-name form");
  const name = form.getByRole("textbox", { name: en.display_name_label, exact: true });
  await expect(form.getByRole("textbox")).toHaveCount(1);
  await expect(name).toHaveValue("Taylor Writer");
  await expect(form.locator('[name="displayNameLatin"]')).toHaveValue("");
  await expect(form.locator("[data-display-name-preview] p")).toHaveCount(0);
  await name.fill("Taylor Updated");
  await form.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page.locator("#settings-display-name [role=status]")).toBeVisible();
  for (const locale of ["en", "ja", "zh-Hans"]) {
    await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
    await page.goto(`/u/dn_single_save?lang=${locale}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Taylor Updated @dn_single_save");
  }
});

test("two name fields preview language choices as typing changes Han and mixed-script names", async ({ page }) => {
  await useMember(page, "dn_fields_preview@example.com", "/settings?lang=ja#settings-display-name");
  await waitForHydration(page);
  const form = page.locator("#settings-display-name form");
  const native = form.getByRole("textbox", { name: formatMessage(ja.display_name_language_label, { language: ja.language_name_ja }), exact: true });
  const latin = form.getByRole("textbox", { name: ja.display_name_romanized_label, exact: true });
  const preview = form.locator("[data-display-name-preview]");
  await expect(preview.locator("p")).toHaveCount(0);
  await native.fill("山田太郎");
  await expect(preview).toContainText(ja.display_name_other_unchanged);
  await latin.fill("Taro Yamada");
  await expect(preview.locator("p")).toHaveCount(3);
  await expect(preview).not.toContainText(ja.display_name_other_unchanged);
  await expect(preview.locator('bdi[dir="ltr"]')).toHaveText("Taro Yamada");
  await native.fill("山田たろう");
  await expect(preview.locator("p")).toHaveCount(2);
  await expect(preview.locator('bdi[dir="ltr"]')).toHaveCount(0);
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await page.goto("/settings?lang=en#settings-display-name");
  await expect(form.getByRole("textbox", { name: formatMessage(en.display_name_language_label, { language: en.language_name_ja }), exact: true })).toBeVisible();
});

test("Chinese screens show native Han names with Latin supplements only in identity locations", async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "zh-Hans", url: state().baseURL }]);
  await useMember(page, "dn_reader@example.com", "/u/dn_han_author?lang=zh-Hans");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText("山田太郎 Taro Yamada @dn_han_author");
  await expect(heading.locator('bdi[dir="ltr"]')).toHaveText("Taro Yamada");
  expect(await page.title()).not.toContain("Taro Yamada");
  await page.goto("/search?q=Han%20article&lang=zh-Hans");
  const row = page.locator("main li").filter({ hasText: "Display name Han article" });
  await expect(row).toContainText("山田太郎");
  await expect(row).not.toContainText("Taro Yamada");
  await row.getByRole("link").filter({ hasText: "Display name Han article" }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  await page.goto(`${new URL(page.url()).pathname}?lang=zh-Hans`);
  for (const selector of ["[data-reading-byline]", "[data-article-signature]"]) {
    await expect(page.locator(selector)).toContainText("山田太郎 Taro Yamada @dn_han_author");
    await expect(page.locator(selector).locator('bdi[dir="ltr"]')).toHaveText("Taro Yamada");
  }
  const reply = page.locator('[id^="reply-meta-"]').filter({ hasText: "@dn_han_reply" });
  await expect(reply).toContainText("佐々木光 Hikaru Sasaki @dn_han_reply");
  await expect(reply.locator('bdi[dir="ltr"]')).toHaveText("Hikaru Sasaki");
});

test("settings save optional names and mention choices insert only handles in both editors", async ({ page }) => {
  await useMember(page, "dn_settings@example.com", "/settings?lang=en");
  await waitForHydration(page);
  const form = page.locator("#settings-display-name form");
  await expect(form.getByRole("textbox")).toHaveCount(2);
  await form.locator('[name="displayName"]').fill("Settings Writer");
  await form.locator('[name="displayNameLatin"]').fill("設定");
  await form.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page.locator("#settings-display-name [role=alert]")).toBeVisible();
  await form.locator('[name="displayNameLatin"]').fill("S. Writer");
  await form.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page.locator("#settings-display-name [role=status]")).toBeVisible();
  await page.goto("/u/dn_settings?lang=en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Settings Writer @dn_settings");
  await page.goto("/t/new?lang=en");
  await waitForHydration(page);
  const editor = page.locator(".ProseMirror");
  await editor.fill("@dn_j");
  const choice = page.getByRole("option").filter({ hasText: "@dn_japanese" });
  await expect(choice).toContainText("Light Writer");
  await choice.click();
  await expect(editor).toContainText("@dn_japanese");
  await expect(editor).not.toContainText("Light Writer");
  await chooseEditorMode(page, en.editor_mode_markdown);
  const markdown = page.locator('textarea[name="body"]');
  await markdown.fill("@dn_j");
  const markdownChoice = page.getByRole("option").filter({ hasText: "@dn_japanese" });
  await expect(markdownChoice).toContainText("Light Writer");
  await markdownChoice.click();
  await expect(markdown).toHaveValue("@dn_japanese ");
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "ja", url: state().baseURL }]);
  await page.goto("/t/new?lang=ja");
  await waitForHydration(page);
  await chooseEditorMode(page, ja.editor_mode_markdown);
  await page.locator('textarea[name="body"]').fill("@dn_j");
  const japaneseChoice = page.getByRole("option").filter({ hasText: "@dn_japanese" });
  await expect(japaneseChoice).toContainText("光の書き手");
  await japaneseChoice.click();
  await expect(page.locator('textarea[name="body"]')).toHaveValue("@dn_japanese ");
  await chooseEditorMode(page, ja.editor_mode_rich);
  await page.locator(".ProseMirror").fill("@dn_j");
  await expect(page.getByRole("option").filter({ hasText: "@dn_japanese" })).toContainText("光の書き手");
});

test("a profile name report keeps its evidence after a name change and removes both current forms", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("display-name-report")) requests.push(request.url()); });
  await useMember(page, "dn_flagger@example.com", "/u/dn_reported?lang=en");
  await waitForHydration(page);
  expect(requests).toHaveLength(0);
  const report = page.locator("details").filter({ has: page.locator("summary", { hasText: en.display_name_report }) });
  await report.locator("summary").click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await report.getByRole("combobox", { name: en.flag_reason, exact: true }).click();
  await page.getByRole("option", { name: en.reason_harassment, exact: true }).click();
  await report.locator('[name="note"]').fill("A name report owned by this scenario");
  await report.getByRole("button", { name: en.flag_submit, exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: en.flag_thanks })).toBeVisible();
  await useMember(page, "dn_reported@example.com", "/settings?lang=en");
  await waitForHydration(page);
  const settings = page.locator("#settings-display-name form");
  await settings.locator('[name="displayName"]').fill("変えた名前");
  await settings.locator('[name="displayNameLatin"]').fill("Changed Name");
  await settings.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page.locator("#settings-display-name [role=status]")).toBeVisible();
  await useMember(page, "dn_operator@example.com", "/mod?lang=en");
  await waitForHydration(page);
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: "@dn_reported", exact: true }) });
  await expect(card.getByRole("heading", { name: en.display_name_current, exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: en.display_name_reported, exact: true })).toBeVisible();
  await expect(card).toContainText("Changed Name");
  await expect(card).toContainText("Reported Name");
  await card.locator('[name="note"]').fill("Display name policy violation");
  await card.getByRole("button", { name: en.display_name_clear, exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.goto("/u/dn_reported?lang=en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("@dn_reported");
  await expect(page.getByText(en.display_name_report, { exact: true })).toHaveCount(0);
});

test("personal villages use the owner's display name and preserve the My village label", async ({ page }) => {
  await useMember(page, "dn_places_reader@example.com");
  for (const locale of ["ja", "en"]) for (const width of [1280, 1100, 390]) {
    const messages = locale === "ja" ? ja : en;
    await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
    const name = locale === "ja" ? "風の書き手" : "Wind Writer";
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/following?lang=${locale}`);
    await expect(page.locator("main").getByRole("link", { name, exact: true })).toHaveCount(0);
    await captureScreenshot(page, { path: `following-${locale}-${width}.png`, fullPage: true }, "personal-village");
    await page.goto(`/?lang=${locale}`);
    if (width === 390) await openPlaces(page);
    await expect(page.getByRole("link", { name, exact: true }).first()).toBeVisible();
    await captureScreenshot(page, { path: `places-${locale}-${width}.png`, fullPage: true }, "personal-village");
    await page.goto(`/following?lang=${locale}`);
    const menu = await openUserMenu(page);
    await expect(menu.getByRole("menuitem", { name: messages.nav_my_page, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
