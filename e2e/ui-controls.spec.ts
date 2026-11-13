import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, useMember, waitForClientRoute, waitForFormReady } from "./helpers";
import { EDITOR_MODE_STORAGE_KEY } from "../app/lib/rich-editor";
import { pressAcrossHydration } from "./support/early-actions";

test.use({ serviceWorkers: "block" });

for (const mode of ["rich", "markdown"]) test(`writing and interface-language lists open on a press spanning hydration in ${mode} mode`, async ({ page }) => {
  await page.addInitScript(({ mode, key }) => localStorage.setItem(key, mode), { mode, key: EDITOR_MODE_STORAGE_KEY });
  await useMember(page, `ui_controls_early_${mode}@example.com`);
  for (const [path, label] of [
    ["/t/new", en.field_lang],
    ["/settings", en.language_select],
  ]) {
    const trigger = () => page.getByRole("combobox", { name: label, exact: true });
    // The writing language is behind "Change" in the post settings: the press that spans hydration is on that, and then the list opens as usual.
    if (path === "/t/new") {
      await pressAcrossHydration(page, path, () => page.locator("[data-post-settings] summary"));
      await expect(page.locator("[data-post-settings]")).toHaveAttribute("open", "");
      await trigger().click();
    } else await pressAcrossHydration(page, path, trigger);
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger()).toBeFocused();
    await expect(page.getByRole("listbox")).toHaveCount(0);
  }
});

test("document navigation restores equivalent focus and leaves outside focus alone", async ({ page }) => {
  await useMember(page, "ui_controls_documents@example.com");
  for (const path of ["/why", "/name", "/principles"]) {
    for (const role of ["home", "missing", "outside"]) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const pause = async (route: import("@playwright/test").Route) => { await gate; await route.continue(); };
      await page.route("**/navigation-header", pause);
      try {
        await page.goto(path);
        await waitForClientRoute(page);
        const target = role === "home" ? page.locator('header a[href="/"]:not([data-navigation-drawer] a)')
          : role === "missing" ? page.locator('header a[href^="/login"]')
          : page.locator("main a").first();
        await target.focus();
        const outside = role === "outside" ? await target.elementHandle() : null;
        release();
        await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
        if (outside) expect(await outside.evaluate(element => document.activeElement === element)).toBe(true);
        else await expect(page.locator('header a[href="/"]:not([data-navigation-drawer] a)')).toBeFocused();
      } finally { release(); await page.unroute("**/navigation-header", pause); }
    }
  }
});

test("quote reply aligns with the beginning of right-to-left text", async ({ page }) => {
  await useMember(page, "ui_controls_quote@example.com", "/t/new");
  const form = page.locator('form:has(textarea[name="body"])');
  await waitForFormReady(form);
  await form.locator('[name="title"]').fill("Direction of quotations");
  await form.locator('[name="body"]').fill("مرحبا بالعالم هذا نص طويل لاختبار موضع زر الاقتباس على الجانب الأيمن من النص.");
  await form.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  const body = page.locator("[data-reading-body]").first();
  // Let the initial translation replace the posted source, then select the
  // original deliberately before testing either direction of the selection.
  await expect(body).toHaveAttribute("lang", "en");
  await waitForClientRoute(page);
  await page.getByRole("link", { name: en.show_original, exact: true }).click();
  await expect(body).toHaveAttribute("lang", "other");
  await body.evaluate(element => { element.setAttribute("dir", "rtl"); });
  for (const backwards of [false, true]) {
    const bounds = await body.locator("p").first().evaluate((paragraph, backwards) => {
      const text = paragraph.firstChild!;
      const selection = getSelection()!;
      selection.setBaseAndExtent(text, backwards ? 25 : 0, text, backwards ? 0 : 25);
      const rect = selection.getRangeAt(0).getClientRects()[0];
      return { left: rect.left, right: rect.right, text: selection.toString() };
    }, backwards);
    const button = page.getByRole("button", { name: en.quote_reply, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(Math.abs(box.x + box.width - bounds.right)).toBeLessThan(2);
    await button.click();
    expect(await page.locator('#reply textarea[name="body"]').inputValue()).toContain(`> ${bounds.text}`);
    await body.scrollIntoViewIfNeeded();
  }
});


test("the new-post destination stays usable after a language-settings press spanning hydration", async ({ page }) => {
  await useMember(page, "ui_controls_village@example.com");
  const trigger = () => page.getByRole("button", { name: new RegExp(`^${en.field_village}\\b`) });
  // Language settings use a native disclosure across hydration. The visible
  // destination menu remains usable independently of that disclosure.
  await pressAcrossHydration(page, "/t/new", () => page.locator("[data-post-settings] summary"));
  await expect(page.locator("[data-post-settings]")).toHaveAttribute("open", "");
  await trigger().click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger()).toBeFocused();
  await page.goto("/settings");
  await waitForClientRoute(page);
  const destination = page.getByRole("combobox", { name: en.settings_default_village, exact: true });
  const next = await destination.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).find(value => value && value !== (document.getElementById("settings-default-village") as HTMLSelectElement).value));
  expect(next).toBeTruthy();
  await destination.selectOption(next!);
  await expect(page.locator("#settings-village").getByRole("status")).toHaveText(en.settings_saved);
  await page.reload();
  await expect(destination).toHaveValue(next!);
});
