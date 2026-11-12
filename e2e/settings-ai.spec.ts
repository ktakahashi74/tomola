import { openTranslationSettings } from "./helpers";
import { LANG_LABELS } from "../app/lib/languages";
import { routeModule } from "./support/module-route";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, escapeRegex, formatMessage, messagePattern, useMember, waitForClientRoute } from "./helpers";
import { HOME_AREA_CHANGE_DAYS } from "../app/lib/profile-settings";
import { AI_CHOICE_STORAGE_KEY } from "../app/lib/open-in-ai";

async function open(page: Page, scenario: string) {
  await useMember(page, `settings_ai_${scenario}@example.com`, "/settings?returnTo=%2Ffollowing");
  await waitForClientRoute(page);
}
const display = (page: Page) => page.locator('select[name="displayLang"]');
const area = (page: Page) => page.getByRole("combobox", { name: en.onboarding_home_area, exact: true });

test("selection saves stay local to each field and persist after reload", async ({ page }) => {
  await open(page, "autosave");
  const languages = page.getByRole("region", { name: en.settings_langs_heading, exact: true });
  await expect(languages.getByRole("button", { name: en.save_changes, exact: true })).toHaveCount(0);
  const ai = page.getByRole("region", { name: en.settings_ai_section_heading, exact: true });
  const emailSection = page.getByRole("region", { name: en.settings_email_heading, exact: true });
  for (const [first, second] of [[languages, ai], [ai, emailSection]]) {
    const id = await second.getAttribute("id");
    expect(await first.evaluate((element, id) => Boolean(element.compareDocumentPosition(document.getElementById(id!)!) & Node.DOCUMENT_POSITION_FOLLOWING), id)).toBe(true);
  }
  await expect(ai.getByRole("link", { name: en.footer_connect, exact: true })).toHaveAttribute("href", "/connect");
  await expect(ai.getByRole("link", { name: en.settings_connections_link, exact: true })).toHaveAttribute("href", "/settings/connections");
  await expect(ai.getByRole("button", { name: en.settings_ai_links_revoke, exact: true })).toBeHidden();
  const advanced = page.locator("#settings-advanced");
  await expect(advanced.getByRole("link", { name: en.settings_tokens_link, exact: true, includeHidden: true })).toHaveAttribute("href", "/settings/tokens");

  await openTranslationSettings(page);
  await display(page).selectOption("fr");
  await expect(page.locator("#settings-display-lang").getByRole("status")).toHaveText(en.settings_saved);
  const read = page.getByRole("group", { name: en.onboarding_read_langs, exact: true });
  await read.getByRole("checkbox", { name: LANG_LABELS.en, exact: true }).check();
  await expect(read.getByRole("status")).toHaveText(en.settings_saved);
  const email = page.getByRole("region", { name: en.settings_email_heading, exact: true });
  await expect(email.getByRole("button", { name: en.settings_email_save, exact: true })).toHaveCount(0);
  for (const [width, choice] of [[1280, en.settings_email_immediate], [390, en.settings_email_none], [390, en.settings_email_daily]] as const) {
    await page.setViewportSize({ width, height: 844 });
    await email.getByRole("radio", { name: choice, exact: true }).check();
    await expect(email.getByRole("status")).toHaveText(en.settings_saved);
    await expect(email.getByRole("status")).toBeInViewport({ ratio: 1 });
    await expect(email.getByRole("radio", { name: choice, exact: true })).toBeChecked();
    await expect(page).toHaveURL(url => url.pathname === "/settings" && !url.searchParams.has("saved"));
    await expect(email.getByText(messagePattern(en.settings_email_digest_at, { time: /.+/ }))).toBeVisible();
  }
  const destination = languages.getByRole("combobox", { name: en.settings_default_village, exact: true });
  if (await destination.count()) {
    await destination.selectOption("ja");
    await expect(page.locator("#settings-village").getByRole("status")).toHaveText(en.settings_saved);
  }
  await expect(area(page)).toHaveValue("ja");
  await expect(page.getByRole("link", { name: en.settings_return, exact: true })).toHaveCount(1);
  await page.reload();
  await expect(area(page)).toHaveValue("ja");
  await expect(display(page)).toHaveValue("fr");
  await expect(read.getByRole("checkbox", { name: LANG_LABELS.en, exact: true })).toBeChecked();
  await expect(email.getByRole("radio", { name: en.settings_email_daily, exact: true })).toBeChecked();
  if (await destination.count()) await expect(destination).toHaveValue("ja");
});

test("a delayed save cannot replace the latest choice and a later failure restores the last saved value", async ({ page }) => {
  await open(page, "ordering");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  await page.route("**/settings/save", async route => {
    if (route.request().method() !== "POST") return route.continue();
    count++;
    const response = await route.fetch();
    if (count === 1) await gate;
    await route.fulfill({ response });
  });
  try {
    await openTranslationSettings(page);
    await display(page).selectOption("en");
    await expect.poll(() => count).toBe(1);
    await openTranslationSettings(page);
    await display(page).selectOption("fr");
    await expect(display(page)).toHaveValue("fr");
    expect(count).toBe(1);
    release();
    await expect(page.locator("#settings-display-lang").getByRole("status")).toHaveText(en.settings_saved);
    expect(count).toBe(2);
    await page.reload();
    await expect(display(page)).toHaveValue("fr");
    await page.unroute("**/settings/save");
    await page.route("**/settings/save", route => route.continue({
      postData: new URLSearchParams({ intent: "preferences", field: "displayLang", autosave: "1", displayLang: "invalid" }).toString(),
      headers: { ...route.request().headers(), "content-type": "application/x-www-form-urlencoded" },
    }));
    await openTranslationSettings(page);
    await display(page).selectOption("ja");
    await expect(page.locator("#settings-display-lang").getByRole("alert")).toHaveText(en.error_generic);
    await expect(display(page)).toHaveValue("fr");
    await page.unroute("**/settings/save");
    await page.reload();
    await expect(display(page)).toHaveValue("fr");
  } finally { release(); }
});

test("network failure restores only the failed field", async ({ page }) => {
  await open(page, "failure");
  await openTranslationSettings(page);
  await display(page).selectOption("en");
  await expect(page.locator("#settings-display-lang").getByRole("status")).toHaveText(en.settings_saved);
  await page.route("**/settings/save", route => route.abort("failed"));
  const email = page.getByRole("region", { name: en.settings_email_heading, exact: true });
  await email.getByRole("radio", { name: en.settings_email_none, exact: true }).check();
  await expect(email.getByRole("alert")).toHaveText(en.settings_email_error);
  await expect(email.getByRole("radio", { name: en.settings_email_auto, exact: true })).toBeChecked();
  await expect(display(page)).toHaveValue("en");
  await expect(area(page)).toHaveValue("ja");
});

test("main-language changes wait for explicit confirmation and keep other preferences", async ({ page }) => {
  await open(page, "area");
  await area(page).selectOption("en");
  const section = page.locator("#settings-area");
  const confirm = section.getByRole("checkbox", { name: formatMessage(en.settings_area_confirm, { days: HOME_AREA_CHANGE_DAYS }), exact: true });
  await expect(confirm).toBeVisible();
  // Saving another field must not submit the pending main-language choice.
  await openTranslationSettings(page);
  await display(page).selectOption("fr");
  await expect(page.locator("#settings-display-lang").getByRole("status")).toHaveText(en.settings_saved);
  const persisted = await page.request.get("/settings");
  const html = await persisted.text();
  const mainLanguage = html.match(/<select[^>]*name="homeArea"[^>]*>[\s\S]*?<\/select>/)?.[0];
  expect(mainLanguage).toMatch(/<option(?=[^>]*value="ja")(?=[^>]*selected=)[^>]*>/);
  const reads = page.getByRole("group", { name: en.onboarding_read_langs, exact: true });
  await reads.getByRole("checkbox", { name: LANG_LABELS.en, exact: true }).check();
  await expect(reads.getByRole("status")).toHaveText(en.settings_saved);
  const destination = page.getByRole("combobox", { name: en.settings_default_village, exact: true });
  if (await destination.count()) {
    await destination.selectOption("ja");
    await expect(page.locator("#settings-village").getByRole("status")).toHaveText(en.settings_saved);
  }
  await confirm.check();
  await section.getByRole("button", { name: en.settings_area_change, exact: true }).click();
  await expect(area(page)).toBeDisabled();
  await expect(area(page)).toHaveValue("en");
  await expect(display(page)).toHaveValue("fr");
  await expect(reads.getByRole("checkbox", { name: LANG_LABELS.en, exact: true })).toBeChecked();
  if (await destination.count()) await expect(destination).toHaveValue("ja");
});

test("AI choices save in this browser and storage errors restore the saved provider", async ({ page }) => {
  await open(page, "storage");
  const ai = page.getByRole("region", { name: en.settings_ai_heading, exact: true });
  const provider = (name: string) => ai.getByRole("radio", { name: new RegExp(`^${escapeRegex(name)}`) });
  await provider(en.open_in_ai_claude).check();
  await expect(ai.getByRole("status")).toHaveText(en.settings_ai_saved);
  expect(await page.evaluate(key => localStorage.getItem(key), AI_CHOICE_STORAGE_KEY)).toBe(JSON.stringify({ provider: "claude" }));
  await expect(ai.getByRole("button", { name: en.open_in_ai_save, exact: true })).toHaveCount(0);
  await page.evaluate(() => { Storage.prototype.removeItem = () => { throw new Error("Storage unavailable"); }; });
  await ai.getByRole("button", { name: en.settings_ai_forget, exact: true }).click();
  await expect(ai.getByRole("alert")).toHaveText(en.error_generic);
  await expect(ai.getByRole("status")).toBeEmpty();
  await expect(provider(en.open_in_ai_claude)).toBeChecked();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); }; });
  await provider(en.open_in_ai_chatgpt).click();
  await expect(ai.getByRole("alert")).toHaveText(en.error_generic);
  await expect(provider(en.open_in_ai_claude)).toBeChecked();
  await page.reload();
  await expect(provider(en.open_in_ai_claude)).toBeChecked();
  await provider(en.open_in_ai_custom).check();
  await ai.getByRole("textbox", { name: en.open_in_ai_template, exact: true }).fill("https://ai.example/chat?q={prompt}");
  await expect(ai.getByRole("status")).toHaveText(en.settings_ai_saved);
  await page.reload();
  await expect(provider(en.open_in_ai_custom)).toBeChecked();
  await expect(ai.getByRole("textbox", { name: en.open_in_ai_template, exact: true })).toHaveValue("https://ai.example/chat?q={prompt}");
});

test("native save controls remain usable when the settings module fails to load", async ({ page }) => {
  await open(page, "broken");
  const moduleRoute = await routeModule(page, "app/routes/settings.tsx", route => route.abort("failed"));
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await moduleRoute.assertHit();
  const languages = page.locator("#settings-languages");
  await openTranslationSettings(page);
  await display(page).selectOption("en");
  await languages.locator('input[name="readLangs"][value="en"]').check();
  await languages.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page).toHaveURL(/saved=preferences/);
  await expect(display(page)).toHaveValue("en");
  await expect(languages.locator('input[name="readLangs"][value="en"]')).toBeChecked();
  await expect(area(page)).toHaveValue("ja");
  const email = page.locator("#settings-email");
  await email.getByRole("radio", { name: en.settings_email_daily, exact: true }).check();
  await email.getByRole("button", { name: en.settings_email_save, exact: true }).click();
  await expect(page).toHaveURL(/saved=email/);
  await expect(email.getByRole("radio", { name: en.settings_email_daily, exact: true })).toBeChecked();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(display(page)).toHaveValue("en");
  await expect(email.getByRole("radio", { name: en.settings_email_daily, exact: true })).toBeChecked();
});
