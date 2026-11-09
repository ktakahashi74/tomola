import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { LANG_LABELS, type Lang } from "../app/lib/languages";
import { clientHeaders, enMessages as en, openPostSettings, openUserMenu, state, uiMessages, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

async function chooseScreen(page: Page, lang: Lang) {
  await waitForClientRoute(page);
  const messages = await uiMessages(page);
  const menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: messages.nav_language, exact: true }).click();
  await page.getByRole("menuitemradio", { name: LANG_LABELS[lang], exact: true }).click();
}

async function expectPreferences(page: Page, displayLang: string) {
  await page.goto("/settings");
  await waitForClientRoute(page);
  const languages = page.locator("#settings-languages");
  await expect(languages.locator('select[name="displayLang"]')).toHaveValue(displayLang);
  expect(await languages.locator('input[name="readLangs"]:checked').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(["ja"]);
  return languages;
}

test("member screen choices clear page reading overrides, protect writing and preserve saved reading preferences", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("198.51.100.245") });
  try {
    await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
    const page = await context.newPage();
    await useMember(page, "lang_switch_member@example.com", "/t/new");
    const title = "A member's screen-language choice";
    const body = "An English original for member language selection.";
    await waitForFormReady(page.locator("form", { has: page.locator('input[name="title"]') }));
    await page.locator('input[name="title"]').fill(title);
    await page.getByRole("textbox", { name: en.field_body, exact: true }).fill(body);
    await openPostSettings(page);
    await page.getByRole("combobox", { name: en.field_lang, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: LANG_LABELS.en, exact: true }).click();
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    const pathname = new URL(page.url()).pathname;
    const retained = "order=activity&page=1&tag=a&tag=b#replies";
    const cleared = new URL(`${pathname}?${retained}`, state().baseURL).href;
    const article = () => page.locator("[data-reading-body]").first();
    await expectPreferences(page, "");

    // The shared address changes the posts while the member's screen stays English.
    await expect(async () => {
      await page.goto(`${pathname}?lang=zh-Hant&rl=1&${retained}`);
      await expect(article()).toContainText(`[zh-Hant] ${body}`);
    }).toPass({ timeout: 60_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await chooseScreen(page, "ja");
    await expect(page).toHaveURL(cleared);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(article()).toContainText(`[ja] ${body}`);
    await expectPreferences(page, "");

    // Reselecting the current language must still ask before discarding unsaved writing.
    const overridden = new URL(`${pathname}?lang=en&rl=1&${retained}`, state().baseURL).href;
    await page.goto(overridden);
    await expect(article()).toContainText(body);
    const reply = page.locator('#reply textarea[name="body"]');
    await waitForFormReady(page.locator("#reply form"));
    await page.route("**/drafts/autosave", route => route.abort());
    const draft = "Keep this reply while refusing navigation.";
    await reply.fill(draft);
    const cookiesBefore = (await context.cookies()).filter(cookie => cookie.name === "PARAGLIDE_LOCALE");
    const dismissed = page.waitForEvent("dialog").then(async dialog => {
      expect(dialog.type()).toBe("confirm");
      await dialog.dismiss();
    });
    await chooseScreen(page, "ja");
    await dismissed;
    await expect(page).toHaveURL(overridden);
    await expect(reply).toHaveValue(draft);
    expect((await context.cookies()).filter(cookie => cookie.name === "PARAGLIDE_LOCALE")).toEqual(cookiesBefore);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await reply.fill("");
    await page.unroute("**/drafts/autosave");
    await chooseScreen(page, "ja");
    await expect(page).toHaveURL(cleared);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(article()).toContainText(`[ja] ${body}`);

    // A saved translation language remains independent of subsequent header choices.
    const languages = await expectPreferences(page, "");
    await languages.locator('select[name="displayLang"]').selectOption("fr");
    await expect(page.locator("#settings-display-lang").getByRole("status")).toHaveText((await uiMessages(page)).settings_saved);
    await page.goto(overridden);
    await chooseScreen(page, "en");
    await expect(page).toHaveURL(cleared);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(article()).toContainText(`[fr] ${body}`);
    await expectPreferences(page, "fr");
  } finally {
    await context.close();
  }
});
