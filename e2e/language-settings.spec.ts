import { openTranslationSettings } from "./helpers";
import { enMessages, openPostSettings } from "./helpers";
import { LANG_LABELS, type Lang } from "../app/lib/languages";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, useMember, clientHeaders, enMessages as en, jaMessages as ja, state } from "./helpers";

test("translation defaults follow the interface while original-reading and explicit preferences remain independent", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ja-JP", extraHTTPHeaders: clientHeaders("10.20.0.1") });
  const page = await context.newPage();
  try {
    await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "ja", url: state().baseURL }]);
    await useMember(page, "language@example.com");
    const post = async (lang: Lang, title: string, body: string) => {
      await page.goto("/t/new");
      // The language select opens from script; a click before the client router is ready is lost.
      await waitForClientRoute(page);
      await page.getByRole("textbox", { name: ja.field_title, exact: true }).fill(title);
      await page.getByRole("textbox", { name: ja.field_body, exact: true }).fill(body);
      await openPostSettings(page);
      await page.getByRole("combobox", { name: ja.field_lang, exact: true }).click();
      await page.getByRole("listbox").getByRole("option", { name: LANG_LABELS[lang], exact: true }).click();
      await page.getByRole("button", { name: ja.submit_post, exact: true }).click();
      // A post in another language than the reader's gets a reading-language hint (?sl=) that can replace ?posted= quickly; check only the new topic's path.
      await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
      return new URL(page.url()).pathname;
    };
    const english = await post("en", "Language English source", "English source sentinel");
    const japanese = await post("ja", "言語設定の日本語原文", "日本語の原文のまま読む確認");
    const thai = await post("th", "Language Thai source", "Thai source sentinel");

    await page.goto("/settings");
    const languages = () => page.getByRole("region", { name: en.settings_langs_heading, exact: true });
    await page.getByRole("region", { name: ja.settings_langs_heading, exact: true }).getByRole("combobox", { name: ja.language_select, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await openTranslationSettings(page);
    await expect(languages().getByRole("combobox", { name: en.display_lang_label, exact: true })).toHaveValue("");
    await expect(languages().locator("select[name=displayLang]")).toHaveValue("");
    await expect(languages().getByRole("combobox", { name: en.onboarding_home_area, exact: true })).toHaveValue("ja");
    await expect(languages().locator("select[name=homeArea]")).toHaveValue("ja");
    await expect(languages().getByRole("group", { name: en.onboarding_read_langs, exact: true }).getByRole("checkbox", { name: "日本語", exact: true })).toBeChecked();
    await expect(page.locator("header").getByRole("combobox", { name: en.display_lang_label, exact: true })).toHaveCount(0);
    const controls = await languages().locator("select, [role=combobox], fieldset").evaluateAll(elements => elements.map(element => element.tagName === "BUTTON" ? element.getAttribute("aria-label")! : element.getAttribute("name") ?? element.tagName));
    expect(controls).toEqual([en.language_select, "FIELDSET", "homeArea", "displayLang"]);

    const article = (target: Page = page) => target.locator("article").first();
    await page.goto(english);
    await expect(article().getByRole("heading", { level: 1 })).toHaveText("Language English source");
    await expect(article().getByText("English source sentinel", { exact: true })).toBeVisible();
    await page.goto(japanese);
    await expect(article().getByRole("heading", { level: 1 })).toHaveText("言語設定の日本語原文");
    await expect(article().getByText("日本語の原文のまま読む確認", { exact: true })).toBeVisible();
    await expect(async () => {
      await page.goto(thai);
      await expect(article().getByRole("heading", { level: 1 })).toHaveText("[en] Language Thai source");
      await expect(article().getByText("[en] Thai source sentinel", { exact: true })).toBeVisible();
    }).toPass({ timeout: 60_000 });
    const cookieHeaders = { cookie: (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; ") };
    const md = await context.request.get(`${state().baseURL}${thai}.md`, { headers: { ...cookieHeaders, "accept-language": "ja-JP" } });
    expect(md.status()).toBe(200);
    expect(await md.text()).toContain("[en] Thai source sentinel");

    await page.goto("/settings");
    await openTranslationSettings(page);
    await languages().getByRole("combobox", { name: en.display_lang_label, exact: true }).selectOption("ja");
    await expect(page.locator("#settings-display-lang").getByRole("status")).toHaveText(en.settings_saved);
    await page.goto(thai);
    await expect(article().getByRole("heading", { level: 1 })).toHaveText("[ja] Language Thai source");
    await expect(article().getByText("[ja] Thai source sentinel", { exact: true })).toBeVisible();
    await page.goto(`${thai}?lang=en`);
    await expect(article().getByRole("heading", { level: 1 })).toHaveText("[en] Language Thai source");
    await page.goto("/settings");
    await openTranslationSettings(page);
    await expect(languages().getByRole("combobox", { name: en.display_lang_label, exact: true })).toHaveValue("ja");
    await expect(languages().locator("select[name=displayLang]")).toHaveValue("ja");
    await expect(languages().getByRole("combobox", { name: en.language_select, exact: true }).locator('[data-slot="select-value"]')).toHaveText(enMessages.language_name_en);
  } finally { await context.close(); }
});
