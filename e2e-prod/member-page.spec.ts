import { request as playwrightRequest, type BrowserContext, type Page } from "@playwright/test";
import { enMessages, openPostSettings } from "../e2e/helpers";
import { expect, openUserMenu, useMember, state, test, watchCsp, type CspWatch } from "./helpers";

// Use the existing unused pat invitation, leaving the production suite's boss/mika accounts untouched.
// These two tests share a dedicated member and post; they also run without production.spec.ts.
test.describe.configure({ mode: "serial" });
const HANDLE = "member_page_pat";
const MEMBER_PATH = `/u/${HANDLE}`;
const TITLE = "Production member page introduction fixture";
const BODY = `Member page production fixture: @${HANDLE} writes about nocturnal moths.`;
let context: BrowserContext;
let page: Page;
let csp: CspWatch;
let topicPath: string;
let mentionPath: string;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, locale: "en-US" });
  page = await context.newPage();
  csp = await watchCsp(page);
});
test.afterAll(async () => { await context?.close(); });

function expectClean() {
  expect(csp.violations, "CSP violations in member pages").toEqual([]);
  expect(csp.pageErrors, "uncaught member page errors").toEqual([]);
  expect(csp.hydrationWarnings, "member page hydration warnings").toEqual([]);
}
async function myPage() {
  await openUserMenu(page);
  await page.getByRole("menuitem", { name: enMessages.nav_my_page, exact: true }).click();
  await expect(page).toHaveURL(new URL(MEMBER_PATH, state().baseURL).href);
  await expect(page.getByRole("heading", { level: 1, name: `@${HANDLE}`, exact: true })).toBeVisible();
}

// The introduction controls live in the author's small actions menu beside "Edit".
async function introButton(name: string) {
  const summary = page.locator(`summary[aria-label="${enMessages.entry_actions}"]`);
  await summary.waitFor();
  if (await summary.locator("xpath=..").getAttribute("open") === null) await summary.click();
  return page.getByRole("button", { name, exact: true });
}

test("a member publishes an introduction, reads it on their page, and removes and restores its designation under CSP", async () => {
  await useMember(page, "pat@example.com");
  await myPage();
  await page.getByRole("link", { name: enMessages.member_page_write_intro, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/new\?intro=1$/);
  await page.locator('input[name="title"]').fill(TITLE);
  await page.locator('textarea[name="body"]').fill(BODY);
  await openPostSettings(page);
  await page.getByLabel(enMessages.field_lang).click();
  await page.getByRole("listbox").getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: TITLE, exact: true })).toBeVisible();
  topicPath = new URL(page.url()).pathname;
  expect(topicPath).toMatch(/^\/t\/\d+$/);
  await expect(await introButton(enMessages.intro_unset)).toBeVisible();
  const mention = page.locator("article").first().locator("a.mention");
  mentionPath = (await mention.getAttribute("href"))!;
  expect(mentionPath).toMatch(/^\/u\/id\/[a-z0-9]{12}$/);

  await myPage();
  const introduction = page.locator("section").filter({ has: page.getByRole("heading", { name: enMessages.member_page_intro_heading, exact: true }) });
  await expect(introduction.locator(".longread")).toContainText(BODY);
  await expect(introduction.locator("a.mention")).toHaveAttribute("href", mentionPath);
  await expect(introduction.getByRole("button")).toHaveCount(0);
  await expect(page.locator("#posts").getByRole("link", { name: TITLE, exact: true })).toHaveAttribute("href", topicPath);
  await introduction.getByRole("link", { name: enMessages.card_open, exact: true }).click();
  await expect(page).toHaveURL(new URL(topicPath, state().baseURL).href);
  await (await introButton(enMessages.intro_unset)).click();
  await expect(await introButton(enMessages.intro_set)).toBeVisible();
  await myPage();
  await expect(page.getByRole("heading", { name: enMessages.member_page_intro_heading, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: enMessages.member_page_write_intro, exact: true })).toBeVisible();
  await expect(page.locator("#posts").getByRole("link", { name: TITLE, exact: true })).toBeVisible();

  await page.goto(topicPath);
  await (await introButton(enMessages.intro_set)).click();
  await expect(await introButton(enMessages.intro_unset)).toBeVisible();
  await myPage();
  await expect(introduction.locator(".longread")).toContainText(BODY);
  // Leave this dedicated account with no designated introduction; keep the post for the read-only link test.
  await page.goto(topicPath);
  await (await introButton(enMessages.intro_unset)).click();
  await expect(await introButton(enMessages.intro_set)).toBeVisible();
  expectClean();
});

test("a mention redirects through a private public-id endpoint to the current member page and visitors must log in", async () => {
  const redirect = await page.request.get(mentionPath, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers()["location"]).toBe(MEMBER_PATH);
  expect(redirect.headers()["cache-control"]).toBe("private, no-store");
  const member = await page.request.get(MEMBER_PATH);
  expect(member.status()).toBe(200);
  expect(member.headers()["cache-control"]).toBe("private, no-store");
  await page.goto(topicPath);
  await page.locator("article").first().locator("a.mention").click();
  await expect(page).toHaveURL(new URL(MEMBER_PATH, state().baseURL).href);
  await expect(page.getByRole("heading", { level: 1, name: `@${HANDLE}`, exact: true })).toBeVisible();

  const visitor = await playwrightRequest.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true });
  try {
    for (const path of [MEMBER_PATH, mentionPath]) {
      const response = await visitor.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(new URL(response.headers()["location"], state().baseURL).pathname).toBe("/login");
      expect(response.headers()["cache-control"]).toMatch(/^private/);
    }
  } finally {
    await visitor.dispose();
  }
  expectClean();
});
