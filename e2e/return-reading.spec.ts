import { hostCookieName } from "./helpers";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { completeTrialFields, waitForClientRoute, captureScreenshot, useMember, visitListRow, clientHeaders, enMessages as en, formatMessage, logSize, loginCodeFor, requestMagicLink, confirmMagicLink, state  } from "./helpers";

let inviterContext: BrowserContext;
let inviter: Page;
const readingCookie = async (context: BrowserContext) => (await context.cookies()).find(cookie => cookie.name === hostCookieName("tomola.reading-return"));

test.beforeAll(async ({ browser }) => {
  inviterContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.170") });
  inviter = await inviterContext.newPage();
  await useMember(inviter, "return_reading_inviter@example.com");
});
test.afterAll(async () => { await inviterContext?.close(); });

async function invite(email: string): Promise<string> {
  await inviter.goto("/invites/new");
  await waitForClientRoute(inviter);
  await inviter.getByLabel(en.invites_email, { exact: true }).fill(email);
  await inviter.getByRole("button", { name: en.invites_submit, exact: true }).click();
  const code = inviter.locator("main code");
  await expect(code).toHaveText(/\/invite\//);
  return (await code.innerText()).trim();
}

async function completeLogin(page: Page, email: string, entry: string, code = false) {
  await page.goto(entry);
  await waitForClientRoute(page);
  const since = logSize();
  const invitation = new URL(entry, state().baseURL).pathname.startsWith("/invite/");
  const link = await requestMagicLink(page, email);
  await expect(page.getByText(formatMessage(invitation ? en.invite_sent : en.login_sent, { email }), { exact: true })).toBeVisible();
  if (code) {
    await page.getByLabel(en.login_code_label, { exact: true }).fill(await loginCodeFor(email, since));
    await page.getByRole("button", { name: invitation ? en.invite_code_submit : en.login_code_submit, exact: true }).click();
  } else {
    await confirmMagicLink(page, link);
  }
}

async function completeProfile(page: Page, handle: string, destination: string) {
  await expect(page).toHaveURL(/\/onboarding(?:\?|$)/);
  await waitForClientRoute(page);
  await page.getByLabel(en.onboarding_handle, { exact: true }).fill(handle);
  await completeTrialFields(page);
  await page.getByRole("button", { name: en.onboarding_join, exact: true }).click();
  await expect(page).toHaveURL(new URL(destination, state().baseURL).href);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", `@${handle}`);
  expect(await readingCookie(page.context())).toBeUndefined();
}

test("an invitation signup returns to the last public topic, preserving its query and forgetting it after signup", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: clientHeaders("192.0.2.171") });
  const page = await context.newPage();
  try {
    const first = await page.goto("/t/1?lang=ja#replies");
    expect(first?.headers()["cache-control"]).toContain("private");
    expect(decodeURIComponent((await readingCookie(context))!.value)).toBe("/t/1?lang=ja");
    await visitListRow(page, "/?lang=en", page.locator("li#q-2"));
    await waitForClientRoute(page);
    await page.locator("li#q-2 > a").click();
    await expect(page).toHaveURL(/\/t\/2\?lang=en$/);
    await expect.poll(async () => decodeURIComponent((await readingCookie(context))?.value ?? "")).toBe("/t/2?lang=en");
    const cookie = (await readingCookie(context))!;
    expect(cookie).toMatchObject({ path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(state().baseURL).protocol === "https:" });
    expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(86300);
    expect(cookie.expires - Date.now() / 1000).toBeLessThanOrEqual(86400);
    const email = "reading_guest@example.com";
    await completeLogin(page, email, await invite(email));
    await expect(page).toHaveURL(/\/onboarding$/);
    expect(await readingCookie(context)).toBeDefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: testInfo.outputPath("signup-return-390.png"), fullPage: true }, "e2e-return-reading");
    await page.getByLabel(en.onboarding_handle, { exact: true }).fill("!");
    await completeTrialFields(page);
    await page.getByRole("button", { name: en.onboarding_join, exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: en.onboarding_error_handle })).toBeVisible();
    expect(await readingCookie(context)).toBeDefined();
    await completeProfile(page, "reading_guest", "/t/2?lang=en");
    const memberRead = await page.goto("/t/1?lang=ja");
    expect(memberRead?.headers()["set-cookie"] ?? "").not.toContain("tomola.reading-return");
    expect(await readingCookie(context)).toBeUndefined();
  } finally { await context.close(); }
});

test("an explicit login return path wins over the last public read when signup uses an email code", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.172") });
  const page = await context.newPage();
  try {
    await page.goto("/t/1?lang=ja");
    const email = "reading_explicit@example.com";
    await invite(email);
    const next = "/t/2?lang=en#reply";
    await completeLogin(page, email, `/login?${new URLSearchParams({ next })}`, true);
    await completeProfile(page, "reading_explicit", next);
  } finally { await context.close(); }
});

for (const [index, value] of ["%2Fsettings"].entries()) {
  test(`an invalid remembered destination falls back home and is deleted (${index + 1})`, async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: clientHeaders(`192.0.2.${173 + index}`) });
    const page = await context.newPage();
    try {
      await context.addCookies([{ name: hostCookieName("tomola.reading-return"), value, url: state().baseURL, secure: new URL(state().baseURL).protocol === "https:", httpOnly: true, sameSite: "Lax" }]);
      const email = `reading_invalid_${index}@example.com`;
      await completeLogin(page, email, await invite(email), true);
      await completeProfile(page, `reading_invalid_${index}`, "/");
    } finally { await context.close(); }
  });
}

test("a registered member's login ignores the last public read and deletes it", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.176") });
  const page = await context.newPage();
  try {
    for (const entry of ["/login", await invite("return_reading_member@example.com")]) {
      await context.clearCookies();
      await page.goto("/t/2?lang=en");
      expect(await readingCookie(context)).toBeDefined();
      await completeLogin(page, "return_reading_member@example.com", entry, true);
      await expect(page).toHaveURL(new URL("/", state().baseURL).href);
      await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@reading_member_login");
      expect(await readingCookie(context)).toBeUndefined();
    }
  } finally { await context.close(); }
});
