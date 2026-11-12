import { expect } from "@playwright/test";
import { routeModule } from "./support/module-route";
import { test } from "./editor-fixture";
import { LANG_LABELS } from "../app/lib/languages";
import { enMessages, messageTitleField, openUserMenu, uiMessages, useMember, waitForClientRoute, waitForFormReady } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

for (const locale of ["ja", "en", "fr"] as const) test(`public and member shells retain their labels after hydration and language selection in ${locale}`, async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const page = await context.newPage();
    const hydrationErrors: string[] = [];
    page.on("pageerror", error => hydrationErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && /hydration|hydrating|did not match|Minified React error/i.test(message.text())) hydrationErrors.push(message.text());
    });
    const response = await page.goto(`/why?lang=${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const publicMessages = await uiMessages(page);
    expect(await response!.text()).toContain(publicMessages.footer_connect);
    await waitForClientRoute(page);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: publicMessages.footer_connect, exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: publicMessages.language_select, exact: true })).toBeVisible();

    await useMember(page, `trim_labels_${locale}@example.com`);
    await waitForClientRoute(page);
    const current = await uiMessages(page);
    const menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: current.nav_language, exact: true }).click();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("menuitemradio", { name: LANG_LABELS[locale], exact: true }).click(),
    ]);
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.reload();
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const messages = await uiMessages(page);
    await expect(page.getByRole("banner").locator('input[name="q"]')).toHaveAttribute("placeholder", messages.nav_search_placeholder);
    await page.setViewportSize({ width: 1280, height: 900 });
    let places = page.locator("[data-site-navigation]");
    if (await places.count() === 0) {
      const drawer = page.locator("[data-navigation-drawer]");
      await drawer.locator(":scope > summary").click();
      places = drawer.locator("nav");
    }
    await expect(places).toHaveAccessibleName(messages.nav_side_label);
    await expect(places.getByRole("link", { name: messages.nav_home, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: messages.nav_glossary, exact: true })).toBeVisible();

    // Public document HTML remains unpersonalized; its later member header
    // must still use the document's server-selected language.
    await page.goto("/why");
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
    await expect(page.getByRole("banner").getByRole("link", { name: messages.nav_new_topic, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: messages.footer_connect, exact: true })).toBeVisible();
    expect(hydrationErrors).toEqual([]);
  } finally { await context.close(); }
});

test("signature approval preloads authentication, preserves writing after a failed load and retries before the confirming click", async ({ page }) => {
  await useMember(page, "trim_auth@example.com", "/settings");
  await enableSigningAuthenticator(page);
  await page.getByRole("button", { name: enMessages.settings_passkeys_add, exact: true }).click();
  await expect(page.getByText(enMessages.settings_passkeys_added, { exact: true })).toBeVisible();
  await page.locator("#settings-advanced > summary").click();
  await page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true }).check();
  await page.locator('form:has(input[name="intent"][value="sign-posts"])').getByRole("button", { name: enMessages.save_changes, exact: true }).click();
  await acceptSignedWrite(page);
  await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts");

  let imports = 0;
  let failImport = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const authenticationModule = await routeModule(page, "@simplewebauthn/browser", async route => {
    imports++;
    if (failImport) { await gate; await route.abort("failed"); }
    else await route.continue();
  });
  try {
  let challenges = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/signing" && request.postDataJSON()?.intent === "challenge") challenges++;
  });
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: messageTitleField(page) }));
  await messageTitleField(page).fill("Preloaded signature fixture");
  const body = "Writing survives a failed authentication module download.";
  await page.getByLabel(enMessages.field_body, { exact: true }).fill(body);
  expect(imports).toBe(0);
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: enMessages.signing_heading, exact: true });
  await expect(dialog).toBeVisible();
  await authenticationModule.assertHit();
  await expect.poll(() => imports).toBe(1);
  await expect(dialog.getByRole("button", { name: enMessages.signing_accept_post, exact: true })).toBeDisabled();
  expect(challenges).toBe(0);
  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert")).toHaveText(enMessages.signing_network_failed);
  await expect(page.getByLabel(enMessages.field_body, { exact: true })).toHaveValue(body);

  failImport = false;
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: enMessages.signing_accept_post, exact: true })).toBeEnabled();
  expect(imports).toBe(2);
  expect(challenges).toBe(0);
  await acceptSignedWrite(page);
  await expect(page).toHaveURL(/\/t\/\d+/);
  } finally { release(); await authenticationModule.dispose(); }
});
