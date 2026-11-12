import { openTranslationSettings } from "../helpers";
import { expect, type Locator, type Page } from "@playwright/test";
import { openPostSettings, uiMessages, waitForClientRoute, waitForFormReady } from "../helpers";
import { beforeHydration } from "./prehydration";
import type { EarlyFixture } from "../seed-early-actions";

export async function pressAcrossHydration(page: Page, path: string, control: () => Locator) {
  await beforeHydration(page, path, async () => {
    await control().scrollIntoViewIfNeeded();
    const box = (await control().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }, async () => {
    await waitForClientRoute(page);
    await page.mouse.up();
    await waitForClientRoute(page);
  });
}

export async function earlySettings(page: Page) {
  const advanced = page.locator("#settings-advanced");
  const aiLinks = page.locator("#settings-ai #settings-links");
  const read = page.locator('#settings-read-langs input[type="checkbox"]').first();
  const display = page.locator('select[name="displayLang"]');
  const email = page.locator('#settings-email input[value="daily"]');
  const destination = page.locator('select[name="village"]');
  let readChecked = false;
  let displayChoice = "";
  let villageChoice: string | undefined;
  let homeArea = "";
  let disclosures: Awaited<ReturnType<Locator["elementHandles"]>> = [];
  await beforeHydration(page, "/settings", async () => {
    await openTranslationSettings(page);
    homeArea = await page.locator('select[name="homeArea"]').inputValue();
    readChecked = !await read.isChecked();
    await read.setChecked(readChecked);
    displayChoice = await display.inputValue() === "en" ? "ja" : "en";
    await display.selectOption(displayChoice);
    await email.check();
    if (await destination.count()) {
      villageChoice = await destination.evaluate(select => [...(select as HTMLSelectElement).options].find(option => option.value && !option.selected)!.value);
      await destination.selectOption(villageChoice);
    }
    await expect(page.locator('#settings-languages button[type="submit"]').last()).toBeVisible();
    await expect(page.locator('#settings-email button[type="submit"]')).toBeVisible();
    disclosures = await page.locator("main details:visible").elementHandles();
    for (const disclosure of disclosures) if (!await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) await (await disclosure.$("summary"))!.click();
    await expect(advanced).toHaveAttribute("open");
  });
  await expect(advanced).toHaveAttribute("open");
  for (const disclosure of disclosures) expect(await disclosure.evaluate(element => element.isConnected && (element as HTMLDetailsElement).open)).toBe(true);
  for (const id of ["settings-read-langs", "settings-display-lang", "settings-email", ...(villageChoice ? ["settings-village"] : [])]) {
    await expect(page.locator(`#${id} [role=status]`)).not.toBeEmpty();
  }
  await expect(read).toBeChecked({ checked: readChecked });
  await expect(display).toHaveValue(displayChoice);
  await expect(email).toBeChecked();
  await expect(page.locator('select[name="homeArea"]')).toHaveValue(homeArea);
  const messages = await uiMessages(page);
  await page.reload();
  await waitForClientRoute(page);
  await expect(read).toBeChecked({ checked: readChecked });
  await expect(display).toHaveValue(displayChoice);
  await expect(email).toBeChecked();
  if (villageChoice) await expect(destination).toHaveValue(villageChoice);
  await expect(page.locator('select[name="homeArea"]')).toHaveValue(homeArea);
  // An unrelated save rerenders the route without taking ownership of open.
  await advanced.locator(":scope > summary").click();
  await page.locator('#settings-email input[value="none"]').check();
  await expect(page.locator("#settings-email [role=status]")).toHaveText(messages.settings_saved);
  await expect(advanced).toHaveAttribute("open");
  await beforeHydration(page, "/settings?saved=ai-links#settings-links", async () => {
    await expect(aiLinks).toHaveAttribute("open");
    await expect(advanced).not.toHaveAttribute("open");
    await aiLinks.locator(":scope > summary").click();
  });
  await expect(aiLinks).not.toHaveAttribute("open");
  // Saving the same section again must still reveal it, even when ?saved is unchanged.
  await aiLinks.locator(":scope > summary").click();
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const pauseSave = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  };
  await page.route("**/settings*", pauseSave);
  try {
    await aiLinks.locator('button[type="submit"]').click({ noWaitAfter: true });
    await aiLinks.locator(":scope > summary").click();
    await expect(aiLinks).not.toHaveAttribute("open");
    resume();
    await expect(aiLinks).toHaveAttribute("open");
    await expect(aiLinks.getByRole("status")).toHaveText(messages.settings_ai_links_revoked);
    await expect(advanced).not.toHaveAttribute("open");
  } finally { resume(); await page.unroute("**/settings*", pauseSave); }
  // Both fallback save buttons precede controls that must survive an early press.
  const locale = () => page.getByRole("combobox", { name: messages.language_select, exact: true });
  await pressAcrossHydration(page, "/settings", locale);
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(locale()).toBeFocused();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await pressAcrossHydration(page, "/settings", () => advanced.locator(":scope > summary"));
  await expect(advanced).toHaveAttribute("open");
  await expect(advanced.locator(":scope > summary")).toHaveText(messages.settings_advanced_heading);
  // Hydrate the server's native 403 document, rather than an action-data fetch.
  const rejectedSave = async (route: import("@playwright/test").Route) => {
    if (!route.request().isNavigationRequest() || new URL(route.request().url()).pathname !== "/settings") {
      await route.continue(); return;
    }
    const response = await route.fetch({ method: "POST", maxRedirects: 0, postData: "intent=sign-posts&signPosts=1", headers: {
      ...await route.request().allHeaders(), Origin: new URL(route.request().url()).origin, "Content-Type": "application/x-www-form-urlencoded",
    } });
    expect(response.status()).toBe(403);
    await route.fulfill({ response });
  };
  await page.route("**/settings", rejectedSave);
  try {
    for (const closeEarly of [false, true]) {
      await beforeHydration(page, "/settings", async () => {
        await expect(advanced).toHaveAttribute("open");
        await page.evaluate(() => window.scrollTo(0, 0));
        if (closeEarly) await advanced.locator(":scope > summary").click();
      });
      if (closeEarly) await expect(advanced).not.toHaveAttribute("open");
      else await expect(page.locator("#settings-signing [role=alert]")).toBeInViewport();
    }
  } finally { await page.unroute("**/settings", rejectedSave); }
}

export async function earlyReports(page: Page, fixture: EarlyFixture) {
  await page.setViewportSize({ width: 390, height: 844 });
  const { topicId, replyId } = fixture.reports;
  const article = page.locator(`#c-${replyId}`);
  const flag = article.locator('details:has(input[name="intent"][value="flag"])');
  let disclosures: Awaited<ReturnType<Locator["elementHandles"]>> = [];
  await beforeHydration(page, `/t/${topicId}?lang=en`, async () => {
    // Report controls are independent of the language and sharing popups, which can overlap one another.
    disclosures = await page.locator('main details:visible:has(input[name="intent"][value="flag"])').elementHandles();
    for (const disclosure of disclosures) await (await disclosure.$("summary"))!.click();
    await flag.locator('[name="note"]').fill("Early report explanation");
  });
  await expect(flag).toHaveAttribute("open");
  // An unreported translation on a reply row is a single button; its optional details open only after a report.
  await expect(article.locator('form:has(input[name="intent"][value="report"]) details')).toHaveCount(0);
  for (const disclosure of disclosures) expect(await disclosure.evaluate(element => element.isConnected && (element as HTMLDetailsElement).open)).toBe(true);
  await expect(flag.locator('[name="note"]')).toHaveValue("Early report explanation");
  await pressAcrossHydration(page, `/t/${topicId}?lang=en`, () => flag.locator("summary"));
  await expect(flag).toHaveAttribute("open");
}

export async function earlyFocus(page: Page) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator('form:has(textarea[name="body"])'));
  const messages = await uiMessages(page);
  // The language control sits in the post settings, behind "Change".
  await openPostSettings(page);
  const language = page.getByRole("combobox", { name: messages.field_lang, exact: true });
  await language.click();
  const popup = page.locator('[data-slot="select-content"]');
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  const body = page.locator('textarea[name="body"]');
  await body.click();
  await body.pressSequentially("Writing after Escape keeps every character", { delay: 15 });
  await expect(popup).toBeHidden();
  await expect(language).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeFocused();
  await expect(body).toHaveValue("Writing after Escape keeps every character");
}
