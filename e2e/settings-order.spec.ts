import { openTranslationSettings } from "./helpers";
import { LANG_LABELS } from "../app/lib/languages";
import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { test } from "./editor-fixture";
import { SIGNATURE_ASSERTION_FIELD, SIGNATURE_CHALLENGE_FIELD } from "../app/lib/signing";
import { captureScreenshot, useMember, waitForClientRoute, clientHeaders, enMessages as en, formatMessage } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

test.describe.configure({ mode: "serial" });
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.26.63.1") });
  page = await context.newPage();
  await useMember(page, "settings_order@example.com");
});
test.afterAll(() => context?.close());

for (const width of [1280, 390]) {
  test(`everyday settings stay visible and advanced tools open through the contents at width ${width}`, async ({}, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings");
    await waitForClientRoute(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const contents = page.getByRole("navigation", { name: en.settings_title, exact: true });
    const advanced = page.locator("#settings-advanced");
    const languages = page.getByRole("region", { name: en.settings_langs_heading, exact: true });
    await expect(page.locator("#settings-display-lang")).not.toBeVisible();
    await openTranslationSettings(page);
    await expect(languages.getByRole("combobox", { name: en.display_lang_label, exact: true })).toBeVisible();
    await expect(languages.getByText(formatMessage(en.settings_display_effect, { lang: LANG_LABELS.en }), { exact: true })).toBeVisible();
    const handle = page.getByRole("region", { name: en.settings_handle_heading, exact: true });
    await expect(handle.getByText("@settings_order", { exact: true })).toBeVisible();
    await expect(handle.getByLabel(en.onboarding_handle, { exact: true })).toBeHidden();
    await handle.locator("summary").click();
    await expect(handle.getByLabel(en.onboarding_handle, { exact: true })).toBeVisible();
    await handle.locator("summary").click();
    const records = page.getByRole("region", { name: en.settings_records_heading, exact: true });
    for (const name of [en.settings_media_title, en.settings_stances_link, en.settings_export_link]) await expect(records.getByRole("link", { name, exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(advanced).not.toHaveAttribute("open");
    await expect(page.getByRole("heading", { name: en.settings_ai_heading, exact: true })).toBeVisible();
    await expect(contents.locator('a[href="#settings-advanced"]')).toHaveCount(1);
    await expect(contents.locator('a[href="#settings-links"], a[href="#settings-share"], a[href="#settings-export"]')).toHaveCount(0);
    await expect(contents).toBeInViewport({ ratio: 1 });
    const early = [en.settings_langs_heading, en.settings_email_heading];
    const later = [en.settings_sessions_heading, en.settings_share_heading];
    for (const first of early) {
      for (const second of later) {
        const firstSection = page.getByRole("region", { name: first, exact: true });
        const secondId = await page.getByRole("region", { name: second, exact: true, includeHidden: true }).getAttribute("id");
        expect(await firstSection.evaluate((element, id) => Boolean(element.compareDocumentPosition(document.getElementById(id!)!) & Node.DOCUMENT_POSITION_FOLLOWING), secondId)).toBe(true);
      }
    }
    for (const link of await contents.getByRole("link").all()) {
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^#.+/);
      const target = page.locator(href!);
      await expect(target).toHaveCount(1);
      const label = href === "#settings-advanced" ? target.locator(":scope > summary") : target.getByRole("heading").first();
      await expect(label).toHaveText((await link.innerText()).trim());
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(label).toBeInViewport();
    }
    expect(await page.locator("main section").evaluateAll(elements => elements.every(element => element.id.length > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/settings");
    await captureScreenshot(page, { path: testInfo.outputPath(`settings-${width}.png`), fullPage: true }, "e2e-settings-order");
    await page.locator("#settings-advanced > summary").click();
    await expect(advanced.getByRole("heading", { level: 2, name: en.settings_advanced_heading, exact: true })).toBeVisible();
    for (const name of [en.settings_sign_posts_label, en.settings_automation_heading, en.settings_share_heading]) await expect(advanced.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
    const share = page.locator("#settings-share");
    await expect(share.getByRole("button", { name: en.settings_share_copy, exact: true })).toBeVisible();
    await expect(share.getByRole("textbox")).toBeHidden();
    await share.getByText(en.settings_share_show, { exact: true }).click();
    await expect(share.getByRole("textbox")).toBeVisible();
    await expect(page.getByRole("heading", { name: en.settings_ai_heading, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureScreenshot(page, { path: testInfo.outputPath(`settings-advanced-${width}.png`), fullPage: true }, "e2e-settings-order");
  });
}

test("an invalid handle remains at its section with the error in view", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await waitForClientRoute(page);
  const handle = page.getByRole("region", { name: en.settings_handle_heading, exact: true });
  await handle.locator("summary").click();
  await handle.getByLabel(en.onboarding_handle, { exact: true }).fill("invalid!handle");
  await handle.getByRole("button", { name: en.settings_handle_heading, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "#settings-handle");
  await expect(handle.getByRole("alert")).toHaveText(en.onboarding_error_handle);
  await expect(handle.getByRole("alert")).toBeInViewport({ ratio: 1 });
  await expect(handle.getByLabel(en.onboarding_handle, { exact: true })).toHaveValue("invalid!handle");
});

test("advanced section fragments open on arrival and after hash changes", async () => {
  for (const id of ["settings-signing", "settings-tokens", "settings-share"]) {
    await page.goto(`/settings#${id}`);
    await waitForClientRoute(page);
    await expect(page.locator("#settings-advanced")).toHaveAttribute("open");
    await expect(page.locator(`#${id}`)).toBeInViewport();
    await expect(page.getByRole("navigation", { name: en.settings_title, exact: true }).getByRole("link", { name: en.settings_advanced_heading, exact: true })).toHaveAttribute("aria-current", "location");
  }
  // Change the hash without native fragment navigation to exercise the JavaScript fallback.
  await page.evaluate(() => {
    (document.getElementById("settings-advanced") as HTMLDetailsElement).open = false;
    history.replaceState(null, "", "#settings-share");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await expect(page.locator("#settings-advanced")).toHaveAttribute("open");
  await expect(page.locator("#settings-share")).toBeInViewport();
});

test("AI-link revocation and rejected signature changes preserve their own disclosures", async ({ browser }) => {
  const native = await browser.newContext({
    locale: "en-US", javaScriptEnabled: true,
    storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("10.26.63.3"),
  });
  try {
    const nativePage = await native.newPage();
    await nativePage.goto("/settings");
    await expect(nativePage.locator("#settings-advanced")).not.toHaveAttribute("open");
    await nativePage.locator("#settings-links > summary").click();
    await nativePage.getByRole("button", { name: en.settings_ai_links_revoke, exact: true }).click();
    await expect(nativePage).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "ai-links" && url.hash === "#settings-links");
    await expect(nativePage.locator("#settings-links")).toHaveAttribute("open");
    await expect(nativePage.locator("#settings-links").getByRole("status")).toBeInViewport();
    for (const saved of ["sign-posts"]) {
      const response = await nativePage.request.get(`/settings?saved=${saved}`);
      const tag = (await response.text()).match(/<details\b[^>]*\bid="settings-advanced"[^>]*>/)?.[0];
      expect(tag).toMatch(/\bopen(?:=|[\s>])/);
    }
    const error = await nativePage.request.post("/settings", {
      form: { intent: "sign-posts", signPosts: "1" },
      headers: { origin: new URL(nativePage.url()).origin },
    });
    expect(error.status()).toBe(403);
    expect(error.headers()["content-type"]).toContain("text/html");
    const errorHtml = await error.text();
    expect(errorHtml.match(/<details\b[^>]*\bid="settings-advanced"[^>]*>/)?.[0]).toMatch(/\bopen(?:=|[\s>])/);
    expect(errorHtml).toContain('role="alert"');
    await nativePage.goto("/settings#settings-share");
    await waitForClientRoute(nativePage);
    await expect(nativePage.locator("#settings-advanced > summary")).toBeVisible();
  } finally {
    await native.close();
  }
});

for (const width of [1280, 390]) {
  test(`signing saves return to their section with feedback in view at width ${width}`, async ({}, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await enableSigningAuthenticator(page);
    await page.goto("/settings");
    if (await page.getByText(en.settings_passkeys_none, { exact: true }).isVisible()) {
      await page.getByRole("button", { name: en.settings_passkeys_add, exact: true }).click();
      await expect(page.getByText(en.settings_passkeys_added, { exact: true })).toBeVisible();
    }
    await page.locator("#settings-advanced > summary").click();
    const signing = page.locator("#settings-signing");
    const signingAction = new URL((await signing.locator("form").getAttribute("action"))!, page.url());
    expect(signingAction.pathname).toBe("/settings"); expect(signingAction.hash).toBe("#settings-signing");
    for (const enabled of [true, false]) {
      await signing.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true }).setChecked(enabled);
      await signing.getByRole("button", { name: en.save_changes, exact: true }).click();
      await acceptSignedWrite(page);
      await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts" && url.hash === "#settings-signing");
      await expect(page.locator("#settings-advanced")).toHaveAttribute("open");
      await expect(signing.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true })).toBeChecked({ checked: enabled });
      await expect(signing.getByRole("status")).toContainText(en.settings_saved);
      await expect(signing.getByRole("status")).toBeInViewport({ ratio: 1 });
    }
    await captureScreenshot(page, { path: testInfo.outputPath(`signing-saved-${width}.png`) }, "e2e-settings-order");
  });

  test(`a rejected signing save opens its section with feedback in view at width ${width}`, async ({}, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings");
    await page.locator("#settings-advanced > summary").click();
    const signing = page.locator("#settings-signing");
    await signing.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true }).check();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rejectUnsigned = async (route: Route) => {
      const form = new URLSearchParams(route.request().postData() ?? "");
      if (route.request().method() !== "POST" || form.get("intent") !== "sign-posts") return route.continue();
      // Exercise the real server's rejection after the user has moved away from the section.
      form.delete(SIGNATURE_ASSERTION_FIELD);
      form.delete(SIGNATURE_CHALLENGE_FIELD);
      await gate;
      await route.continue({ postData: form.toString() });
    };
    await page.route("**/settings.data*", rejectUnsigned);
    try {
      const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/settings.data");
      await signing.getByRole("button", { name: en.save_changes, exact: true }).click();
      await acceptSignedWrite(page);
      await page.evaluate(() => {
        (document.getElementById("settings-advanced") as HTMLDetailsElement).open = false;
        window.scrollTo(0, 0);
      });
      release();
      expect((await response).status()).toBe(403);
      await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "");
      await expect(page.locator("#settings-advanced")).toHaveAttribute("open");
      await expect(signing.getByRole("alert")).toHaveText(en.signing_failed);
      await expect(signing.getByRole("alert")).toBeInViewport({ ratio: 1 });
      await captureScreenshot(page, { path: testInfo.outputPath(`signing-rejected-${width}.png`) }, "e2e-settings-order");
      await page.reload();
      await page.locator("#settings-advanced > summary").click();
      await expect(signing.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true })).not.toBeChecked();
    } finally {
      release();
      await page.unroute("**/settings.data*", rejectUnsigned);
    }
  });
}
