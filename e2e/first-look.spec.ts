import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as m, loginWithMagicLink, state, useMember as visitMember, waitForClientRoute } from "./helpers";
import { ELIGIBLE_COUNTRY, EXCLUDED_COUNTRY } from "./operator-fixture";

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "first-look.json"), "utf8")) as {
  questionId: number; topicId: number; firstNew: number; lastRead: number; invitations: Record<string, string>;
  listQuestionId: number; pagedQuestionId: number; pagedReplyId: number;
};

async function startSignup(page: Page, scenario: string) {
  await page.context().setExtraHTTPHeaders(clientHeaders(`10.89.2.${["preserve", "leave", "excluded", "retry"].indexOf(scenario) + 1}`));
  await page.goto(fixture().invitations[scenario]);
  await waitForClientRoute(page);
  await loginWithMagicLink(page, `firstlook_${scenario}@example.com`);
  await expect(page).toHaveURL(/\/onboarding$/);
  await waitForClientRoute(page);
}

async function observeDraftOnBack(page: Page) {
  await page.evaluate(() => window.addEventListener("popstate", event => {
    sessionStorage.setItem("first-look-returned-draft", JSON.stringify(event.state?.onboarding ?? null));
  }, { once: true }));
}

test("retains all onboarding inputs after reading both notices in the same tab", async ({ page }) => {
  await startSignup(page, "preserve");
  await page.locator('input[name="handle"]').fill("firstlook_preserve");
  await page.getByRole("combobox", { name: m.onboarding_home_area, exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page.locator('select[name="residenceCountry"]').selectOption(ELIGIBLE_COUNTRY);
  await page.locator('input[name="adult"]').check();
  await page.locator('input[name="trialAgree"]').check();
  for (const notice of ["terms", "privacy"]) {
    await page.locator(`main a[href="/${notice}"]`).last().click();
    await expect(page.locator("article h1")).toBeVisible();
    await page.goBack();
    await waitForClientRoute(page);
    await expect(page.locator('input[name="handle"]')).toHaveValue("firstlook_preserve");
    await expect(page.locator('input[name="homeArea"]')).toHaveValue("en");
    await expect(page.locator('select[name="residenceCountry"]')).toHaveValue(ELIGIBLE_COUNTRY);
    await expect(page.locator('input[name="adult"]')).toBeChecked();
    await expect(page.locator('input[name="trialAgree"]')).toBeChecked();
  }
  await observeDraftOnBack(page);
  await page.getByRole("button", { name: m.onboarding_join, exact: true }).click();
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@firstlook_preserve");
  await page.goBack();
  expect(await page.evaluate(() => sessionStorage.getItem("first-look-returned-draft"))).toBe("null");
});

test("keeps the onboarding draft after a failed submission and another notice visit", async ({ page }) => {
  await startSignup(page, "retry");
  await page.locator('input[name="handle"]').fill("firstlook_author");
  await page.getByRole("combobox", { name: m.onboarding_home_area, exact: true }).click();
  await page.getByRole("option", { name: "日本語", exact: true }).click();
  await page.locator('select[name="residenceCountry"]').selectOption(ELIGIBLE_COUNTRY);
  await page.locator('input[name="adult"]').check();
  await page.locator('input[name="trialAgree"]').check();
  await page.getByRole("button", { name: m.onboarding_join, exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.history.state?.onboarding)).toMatchObject({ handle: "firstlook_author", homeArea: "ja", country: ELIGIBLE_COUNTRY, adult: true, agree: true });
  await page.locator('main a[href="/privacy"]').last().click();
  await page.goBack();
  await waitForClientRoute(page);
  await expect(page.locator('input[name="handle"]')).toHaveValue("firstlook_author");
  await expect(page.locator('input[name="homeArea"]')).toHaveValue("ja");
  await expect(page.locator('select[name="residenceCountry"]')).toHaveValue(ELIGIBLE_COUNTRY);
  await expect(page.locator('input[name="adult"]')).toBeChecked();
  await expect(page.locator('input[name="trialAgree"]')).toBeChecked();
});

for (const scenario of ["leave", "excluded"]) test(`reading exit ends an unfinished signup (${scenario})`, async ({ page }) => {
  await startSignup(page, scenario);
  await page.locator('input[name="handle"]').fill(`firstlook_${scenario}`);
  if (scenario === "excluded") {
    await page.locator('input[name="handle"]').fill("firstlook_excluded");
    await page.locator('select[name="residenceCountry"]').selectOption(EXCLUDED_COUNTRY);
    await page.locator('input[name="adult"]').check();
    await page.locator('input[name="trialAgree"]').check();
    await page.getByRole("button", { name: m.onboarding_join, exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  }
  const scope = scenario === "excluded" ? page.getByRole("alert") : page.locator("main");
  await observeDraftOnBack(page);
  await scope.getByRole("button", { name: m.onboarding_leave, exact: true }).click();
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(0);
  const response = await page.request.get("/onboarding", { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toMatch(/^\/login/);
  await page.goBack();
  expect(await page.evaluate(() => sessionStorage.getItem("first-look-returned-draft"))).toBe("null");
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: m.footer_why, exact: true }).click();
  await expect(page.locator("article h1")).toBeVisible();
});

test("reading exit is absent for existing members reviewing participation", async ({ page }) => {
  for (const member of ["firstlook_existing", "firstlook_existing_excluded"]) {
    await visitMember(page, `${member}@example.com`, "/settings");
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: m.onboarding_review_title })).toBeVisible();
    await expect(page.getByRole("button", { name: m.onboarding_leave, exact: true })).toHaveCount(0);
    if (member.endsWith("excluded")) await expect(page.getByRole("link", { name: m.onboarding_read_only, exact: true })).toBeVisible();
  }
});

test("consent returns to the intended stance without recording it until another press", async ({ page, browser }) => {
  const { questionId } = fixture();
  await visitMember(page, "firstlook_stance@example.com", `/t/${questionId}`);
  await waitForClientRoute(page);
  const requested: string[] = [];
  page.on("request", request => requested.push(request.url()));
  await page.locator('#stance button[value="disagree"]').click();
  await expect(page).toHaveURL(/\/settings\/stances\?.*#consent$/);
  expect(await (await page.request.get("/settings/stances")).text()).not.toContain(`id="q-${questionId}"`);
  await page.locator('input[name="agree"]').check();
  await page.locator('#consent button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/t/${questionId}.*#stance$`));
  expect(new URL(page.url()).search).toBe("");
  expect((await page.context().cookies()).some(cookie => cookie.name.endsWith("tomola.stance-resume"))).toBe(false);
  const choice = page.locator('#stance button[value="disagree"]');
  await expect(choice).toBeFocused();
  await expect(page.locator("#stance [role=status]")).toBeVisible();
  for (const position of ["agree", "disagree", "neither"]) await expect(page.locator(`#stance button[value="${position}"]`)).toHaveAttribute("aria-pressed", "false");
  expect(await (await page.request.get("/settings/stances")).text()).not.toContain(`id="q-${questionId}"`);
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#stance [role=status]")).toHaveCount(0);
  await page.reload();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  expect(requested.some(url => /stance_(?:choice|q)|stance_msg=consented/.test(url))).toBe(false);
  const shared = page.url();
  const otherContext = await browser.newContext({ baseURL: state().baseURL, extraHTTPHeaders: clientHeaders("10.89.2.5") });
  try {
    const other = await otherContext.newPage();
    await visitMember(other, "firstlook_stance_peer@example.com", shared);
    await expect(other.locator("#stance [role=status]")).toHaveCount(0);
    await expect(other.locator('#stance button[value="disagree"]')).toHaveAttribute("aria-pressed", "false");
    await visitMember(other, "firstlook_stance_unconsented@example.com", `/t/${questionId}?stance_msg=consented&stance_choice=disagree&stance_q=${questionId}#stance`);
    await expect(other.locator("#stance [role=status]")).toHaveCount(0);
    await expect(other.locator('#stance button[value="disagree"]')).not.toBeFocused();
  } finally { await otherContext.close(); }
});

for (const source of ["list", "replies"] as const) test(`consent returns from the second ${source} page to a readable question`, async ({ page }) => {
  const data = fixture();
  const questionId = source === "list" ? data.listQuestionId : data.pagedQuestionId;
  const path = source === "list" ? "/following?all=1&page=2&asks=1&order=activity&long=1&lang=en" : `/t/${questionId}?page=2&lang=en`;
  await visitMember(page, `firstlook_${source === "list" ? "list" : "paged"}_consent@example.com`, path);
  await waitForClientRoute(page);
  const panel = page.locator(source === "list" ? `#q-${questionId}` : "#stance");
  if (source === "replies") await expect(page.locator(`#c-${data.pagedReplyId}`)).toBeVisible();
  await panel.locator('button[value="agree"]').click();
  await expect(page).toHaveURL(/\/settings\/stances\?.*#consent$/);
  const search = source === "list" ? "?lang=en" : "?page=2&lang=en";
  await expect(page.locator('input[name="next"]')).toHaveValue(`/t/${questionId}${search}#stance`);
  await page.locator('input[name="agree"]').check();
  const returned = page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === `/t/${questionId}`);
  await page.getByRole("button", { name: m.stance_consent_continue, exact: true }).click();
  expect((await returned).status()).toBe(200);
  await expect(page).toHaveURL(url => url.pathname === `/t/${questionId}` && url.search === search && url.hash === "#stance");
  await expect(page.locator("#stance [role=status]")).toBeVisible();
  await expect(page.locator('#stance button[value="agree"]')).toBeFocused();
  await expect(page.locator('#stance button[value="agree"]')).toHaveAttribute("aria-pressed", "false");
  if (source === "replies") await expect(page.locator(`#c-${data.pagedReplyId}`)).toBeVisible();
});

test("notification reaches the first new reply inside a folded branch on its page", async ({ page }) => {
  const { topicId, firstNew, lastRead } = fixture();
  await visitMember(page, "firstlook_reader@example.com", "/notifications");
  await waitForClientRoute(page);
  await page.evaluate(({ topicId, lastRead }) => localStorage.setItem("tomola.seen-replies", JSON.stringify([[topicId, lastRead]])), { topicId, lastRead });
  await page.getByRole("link").filter({ hasText: "New replies across pages" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${topicId}\\?page=2#c-${firstNew}$`));
  await expect(page.locator('[data-new-replies] a')).toHaveAttribute("href", `#c-${firstNew}`);
  await expect(page.locator(`#c-${firstNew}`)).toBeInViewport();
  await expect(page.locator(`#c-${firstNew}`)).toHaveAttribute("data-new-reply", "");
});

test("Latin-script names are saved from one field", async ({ page }) => {
  await visitMember(page, "firstlook_names@example.com", "/settings#settings-display-name");
  const fields = page.locator('#settings-display-name input[name^="displayName"]:not([type=hidden])');
  await expect(fields).toHaveCount(1);
  await fields.first().fill("One Field");
  await page.locator("#settings-display-name").getByRole("button", { name: m.save_changes, exact: true }).click();
  await expect(page.locator("#settings-display-name [role=status]")).toBeVisible();
  await page.reload();
  await expect(fields).toHaveCount(1);
  await expect(fields.first()).toHaveValue("One Field");
});

test("why groups languages and opens the group containing the current edition", async ({ page }) => {
  await page.goto("/why?lang=en");
  const languages = page.locator("main nav");
  const more = languages.locator("details");
  await expect(more).not.toHaveAttribute("open", "");
  await more.locator("summary").click();
  await languages.locator('a[hreflang="ar"]').click();
  await expect(page.locator('article[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(more).toHaveAttribute("open", "");
  await expect(languages.locator('[aria-current="page"][lang="ar"]')).toBeVisible();
});
