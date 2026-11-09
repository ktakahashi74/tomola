import { completeTrialFields } from "./helpers";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, waitForClientRoute, clientHeaders, enMessages as en, jaMessages as ja, logSize, loginCodeFor, requestMagicLink, confirmMagicLink, openUserMenu, openPlaces, closePlaces, state  } from "./helpers";

// The member test signs in as the member registered by the first test, so the tests run in order.
test.describe.configure({ mode: "serial" });

type Messages = typeof en;
async function guestHeader(page: Page, messages: Messages, login: boolean) {
  const header = page.locator("header");
  await expect(header).toHaveCount(1);
  await expect(header.getByRole("link", { name: messages.site_name, exact: true })).toHaveAttribute("href", "/");
  await expect(header.getByRole("link", { name: messages.footer_why, exact: true })).toHaveAttribute("href", "/why");
  await expect(header.getByRole("link", { name: messages.footer_principles, exact: true })).toHaveAttribute("href", "/principles");
  await expect(header.getByRole("combobox", { name: messages.language_select, exact: true })).toBeVisible();
  await expect(header.getByRole("link", { name: messages.login_title, exact: true })).toHaveCount(login ? 1 : 0);
  await expect(header.locator("[data-member-menu-trigger]")).toHaveCount(0);
}

async function whyLinksBeforeMain(page: Page, messages: Messages) {
  return page.getByRole("link", { name: messages.footer_why, exact: true }).evaluateAll(links => {
    const main = document.querySelector("main")!;
    return links.filter(link => link.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map(link => ({ href: link.getAttribute("href"), inHeader: !!link.closest("header") }));
  });
}

async function evidence(page: Page, name: string, outputPath: (name: string) => string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${width}px`).toBe(true);
    await captureScreenshot(page, { path: outputPath(`${name}-${width}.png`), animations: "disabled" }, "e2e-entry-header");
  }
}

test("entry screens share a guest header and keep signup, confirmation and code states intact", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.210") });
  const page = await context.newPage();
  const outputPath = (name: string) => testInfo.outputPath(name);
  try {
    await page.goto("/login");
    await waitForClientRoute(page);
    await guestHeader(page, en, false);
    await expect(page.locator("main").getByText(en.entry_intro, { exact: true })).toBeVisible();
    await evidence(page, "login-en", outputPath);

    await page.goto(state().entryHeaderInvite);
    await waitForClientRoute(page);
    await guestHeader(page, en, false);
    await expect(page.locator("main").getByText(en.entry_intro, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: en.invite_submit, exact: true })).toBeVisible();
    await expect(page.getByText(en.public_reading_onboarding, { exact: true })).toHaveCount(testInfo.config.metadata.publicReading ? 1 : 0);
    await evidence(page, "invite-en", outputPath);
    const link = await requestMagicLink(page, "entry_header@example.com");
    await expect(page.getByRole("heading", { name: en.login_code_heading, exact: true })).toBeVisible();
    await guestHeader(page, en, false);
    await expect(page.getByText(en.entry_intro, { exact: true })).toHaveCount(0);
    await evidence(page, "invite-code-en", outputPath);

    await page.goto(link);
    await guestHeader(page, en, false);
    await expect(page.getByRole("button", { name: en.confirm_submit, exact: true })).toBeVisible();
    await evidence(page, "confirm-en", outputPath);
    await confirmMagicLink(page);
    await expect(page).toHaveURL(/\/onboarding$/);
    await waitForClientRoute(page);
    await guestHeader(page, en, false);
    await expect(page.locator("header").getByRole("button", { name: en.nav_logout, exact: true })).toBeVisible();
    await evidence(page, "onboarding-en", outputPath);
    await page.getByLabel(en.onboarding_handle, { exact: true }).fill("header_reader");
    await completeTrialFields(page);
    await page.getByRole("button", { name: en.onboarding_join, exact: true }).click();
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@header_reader");
    const menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: en.nav_logout, exact: true }).click();
    if (testInfo.config.metadata.publicReading) {
      // Where reading needs no login, leaving a session lands on the posts, with the notice above them.
      await expect(page).toHaveURL(new URL("/", state().baseURL).href);
      await expect(page.getByRole("status").filter({ hasText: en.logged_out })).toHaveText(en.logged_out);
    } else {
      await expect(page).toHaveURL(new URL("/login", state().baseURL).href);
      await expect(page.locator("main > :first-child")).toHaveAttribute("role", "status");
      await expect(page.locator("main").getByRole("status")).toHaveText(en.logged_out);
    }
    await evidence(page, "logout-en", outputPath);
  } finally { await context.close(); }
});

for (const [index, locale, messages] of [[0, "ja-JP", ja], [1, "en-US", en]] as const) {
  test(`public documents and entry navigation use the interface language (${locale})`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ locale, extraHTTPHeaders: clientHeaders(`192.0.2.${211 + index}`) });
    const page = await context.newPage();
    try {
      for (const path of ["/login", "/invite/not-a-valid-invitation", "/auth/confirm", "/why", "/name", "/principles?lang=ar"]) {
        await page.goto(path);
        await waitForClientRoute(page);
        const operator = JSON.parse((await page.locator('meta[name="tomola-operator"]').getAttribute("content"))!);
        const interfaceLanguage = await page.locator("html").getAttribute("lang");
        expect(Object.keys(operator.name)).toEqual([interfaceLanguage]);
        expect(Object.keys(operator.participation.copy)).toEqual([interfaceLanguage]);
        expect(await page.evaluate(() => "operator" in (window as unknown as { __reactRouterContext: { state: { loaderData: { root: object } } } }).__reactRouterContext.state.loaderData.root)).toBe(false);
        const document = path.startsWith("/why") || path.startsWith("/name") || path.startsWith("/principles");
        await guestHeader(page, messages, document);
        if (document) expect(await whyLinksBeforeMain(page, messages)).toEqual([{ href: "/why", inHeader: true }]);
        if (path === "/login") await expect(page.getByText(messages.entry_intro, { exact: true })).toBeVisible();
        if (path.startsWith("/principles")) {
          await expect(page.locator("article")).toHaveAttribute("lang", "ar");
          await expect(page.locator("article")).toHaveAttribute("dir", "rtl");
        }
        await evidence(page, `${path.split("?")[0].replaceAll("/", "-")}-${locale}`, name => testInfo.outputPath(name));
      }
    } finally { await context.close(); }
  });
}

test("members retain their navigation on public documents while the HTML and twins stay public", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.213") });
  const page = await context.newPage();
  try {
    await page.goto("/login");
    await waitForClientRoute(page);
    const since = logSize();
    // Use this suite's own member: login emails to an address shared with other suites count against that address's limit.
    await page.getByLabel(en.login_email, { exact: true }).fill("entry_header@example.com");
    await page.getByRole("button", { name: en.login_submit, exact: true }).click();
    await expect(page.getByRole("heading", { name: en.login_code_heading, exact: true })).toBeVisible();
    await page.getByLabel(en.login_code_label, { exact: true }).fill(await loginCodeFor("entry_header@example.com", since));
    await page.getByRole("button", { name: en.login_code_submit, exact: true }).click();
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    for (const path of ["/name", "/why", "/principles?lang=ar"]) {
      const response = await page.goto(path);
      expect(await response!.text()).not.toContain('title="@header_reader"');
      const header = page.locator("header");
      await expect(header.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@header_reader");
      const places = await openPlaces(page);
      await expect(places.getByRole("link", { name: en.nav_following, exact: true })).toBeVisible();
      await closePlaces(page);
      await expect(header.getByRole("link", { name: new RegExp(`^${en.nav_notifications}`) })).toBeVisible();
      await expect(header.getByRole("link", { name: en.login_title, exact: true })).toHaveCount(0);
      expect(await whyLinksBeforeMain(page, en)).toEqual(path.startsWith("/principles") ? [{ href: "/why", inHeader: true }] : []);
      await evidence(page, `${path.split("?")[0].slice(1)}-member`, name => testInfo.outputPath(name));
      const navigation = await page.request.get("/navigation-header");
      expect(navigation.headers()["cache-control"]).toBe("private, no-store");
      expect(navigation.headers().vary).toContain("Cookie");
      for (const suffix of ["md", "txt"]) {
        const twin = await page.request.get(`${path.split("?")[0]}.${suffix}`);
        expect(twin.status()).toBe(200);
        expect(await twin.text()).not.toContain("@header_reader");
      }
    }
    let release!: () => void;
    let requested!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const pending = new Promise<void>(resolve => { requested = resolve; });
    const observed = await page.evaluateHandle(label => {
      const state = { sawLogin: false };
      const observer = new MutationObserver(() => {
        state.sawLogin ||= [...document.querySelectorAll("header a")].some(link => link.textContent?.trim() === label);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return { state, observer };
    }, en.login_title);
    await page.route("**/navigation-header", async route => {
      requested();
      await hold;
      await route.continue();
    }, { times: 1 });
    try {
      await page.locator('main a[href="/principles?lang=de"]').click();
      await pending;
      await expect(page.locator("article")).toHaveAttribute("lang", "de");
      await expect(page.locator("header [data-member-menu-trigger]")).toHaveAttribute("title", "@header_reader");
      await expect(page.locator("header").getByRole("link", { name: en.login_title, exact: true })).toHaveCount(0);
      expect(await whyLinksBeforeMain(page, en)).toEqual([{ href: "/why", inHeader: true }]);
      const response = page.waitForResponse(response => new URL(response.url()).pathname === "/navigation-header");
      release();
      expect((await response).status()).toBe(200);
      expect(await observed.evaluate(({ state }) => state.sawLogin)).toBe(false);
    } finally {
      release();
      await observed.evaluate(({ observer }) => observer.disconnect());
      await observed.dispose();
    }
    await context.route("**/navigation-header", route => route.abort());
    await page.goto("/why");
    await expect(page.locator("main article h1")).toBeVisible();
    await guestHeader(page, en, true);
  } finally { await context.close(); }
});
