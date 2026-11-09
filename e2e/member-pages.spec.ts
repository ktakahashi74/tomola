import { enMessages } from "./helpers";
import fs from "node:fs";
import { expect, request, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, clientHeaders, enMessages as en, openUserMenu, state, messageTitleField as titleField, waitForFormReady } from "./helpers";

// One member's introduction, its ordinary post, current author links, stable mentions, and the seeded member's topic pagination.
test.describe.configure({ mode: "serial" });
const MEMBER = "member_profile";
const RENAMED = "member_profile_new";
const EMAIL = `${MEMBER}@example.com`;
const TITLE = "About my interests";
const BODY = `I am @${MEMBER}. I would like to discuss scientific AI.`;
let ownerContext: BrowserContext;
let owner: Page;
let topicPath: string;
let mentionHref: string;

test.beforeAll(async ({ browser }) => {
  ownerContext = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.41.1") });
  owner = await ownerContext.newPage();
});
test.afterAll(async () => {
  await ownerContext?.close();
});

async function ownPage(handle = MEMBER) {
  const menu = await openUserMenu(owner);
  const link = menu.getByRole("menuitem", { name: en.nav_my_page, exact: true });
  await expect(link).toHaveAttribute("href", `/u/${handle}`);
  await link.click();
  await expect(owner).toHaveURL(new RegExp(`/u/${handle}$`));
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText(`@${handle}`);
}
async function expectMemberPageOnly(page: Page) {
  const main = page.locator("main");
  await expect(main.locator('button[aria-pressed], form[action="/vote"], form[action="/stance"], [data-position]')).toHaveCount(0);
  await expect(main.getByText(en.onboarding_home_area, { exact: true })).toHaveCount(0);
  await expect(main.getByText(en.onboarding_read_langs, { exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: en.insightful_give, exact: true })).toHaveCount(0);
}

test("the member header opens an empty own page with the introduction entry point", async () => {
  await useMember(owner, EMAIL);
  await ownPage();
  await expect(owner.getByRole("link", { name: en.member_page_write_intro, exact: true })).toHaveAttribute("href", "/t/new?intro=1");
  await expect(owner.getByText(en.member_page_topics_empty, { exact: true })).toBeVisible();
  await expectMemberPageOnly(owner);
});

test("the introduction default and question choice are mutually exclusive, and posting keeps the ordinary thread", async () => {
  await owner.getByRole("link", { name: en.member_page_write_intro, exact: true }).click();
  await expect(owner).toHaveURL(/\/t\/new\?intro=1$/);
  await waitForFormReady(owner.locator("form", { has: titleField(owner) }));
  const intro = owner.getByRole("checkbox", { name: en.intro_checkbox, exact: true });
  const question = owner.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true });
  await expect(intro).toBeChecked();
  await expect(owner.getByRole("button", { name: en.ai_write_button, exact: true })).toHaveCount(0);
  await expect(question).not.toBeChecked();
  await question.check();
  await expect(intro).not.toBeChecked();
  await expect(owner.getByRole("button", { name: en.ai_write_button, exact: true })).toBeVisible();
  await intro.check();
  await expect(question).not.toBeChecked();
  await titleField(owner).fill(TITLE);
  await owner.getByLabel(en.field_body, { exact: true }).fill(BODY);
  await owner.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(owner.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  topicPath = new URL(owner.url()).pathname;
  await expect(owner.locator(`[data-reading-byline] a[href="/u/${MEMBER}"]`)).toHaveText(`@${MEMBER}`);
  const mention = owner.locator("article a.mention");
  await expect(mention).toHaveText(`@${MEMBER}`);
  mentionHref = (await mention.getAttribute("href"))!;
  expect(mentionHref).toMatch(/^\/u\/id\/[a-z0-9]{12}$/);
  await expect(owner.getByRole("button", { name: en.intro_unset, exact: true })).toBeVisible();
});

test("the own page shows the introduction; unset and set preserve its post and original-language row", async () => {
  await ownPage();
  await expect(owner.getByRole("heading", { name: en.member_page_intro_heading, exact: true })).toBeVisible();
  await expect(owner.locator('main section[id^="p-"] .longread')).toContainText(BODY);
  await expect(owner.locator('#posts span[lang="en"]')).toHaveText(enMessages.language_name_en);
  await expectMemberPageOnly(owner);
  await owner.getByRole("link", { name: en.card_open, exact: true }).click();
  await expect(owner).toHaveURL(new RegExp(`${topicPath}(?:\\?sl=[\\w-]+)?$`));
  await owner.getByRole("button", { name: en.intro_unset, exact: true }).click();
  await expect(owner.getByRole("button", { name: en.intro_set, exact: true })).toBeVisible();
  await ownPage();
  await expect(owner.getByRole("heading", { name: en.member_page_intro_heading, exact: true })).toHaveCount(0);
  await expect(owner.getByRole("link", { name: en.member_page_write_intro, exact: true })).toBeVisible();
  await owner.locator("#posts").getByRole("link", { name: TITLE, exact: true }).click();
  await expect(owner.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await owner.getByRole("button", { name: en.intro_set, exact: true }).click();
  await expect(owner.getByRole("button", { name: en.intro_unset, exact: true })).toBeVisible();
  await ownPage();
  await expect(owner.getByRole("heading", { name: en.member_page_intro_heading, exact: true })).toBeVisible();
});

test("renaming updates author and own-page links while the written mention retains its public-id destination", async () => {
  await owner.goto("/settings");
  await owner.locator("#settings-handle summary").click();
  const form = owner.locator("form", { has: owner.locator('input[name="handle"]') });
  await form.locator('input[name="handle"]').fill(RENAMED);
  await form.getByRole("button", { name: en.settings_handle_heading, exact: true }).click();
  await expect(owner.locator("[data-member-menu-trigger]")).toHaveAttribute("title", `@${RENAMED}`);
  await owner.goto(topicPath);
  await expect(owner.locator(`[data-reading-byline] a[href="/u/${RENAMED}"]`)).toHaveText(`@${RENAMED}`);
  const mention = owner.locator("article a.mention");
  await expect(mention).toHaveText(`@${MEMBER}`);
  await expect(mention).toHaveAttribute("href", mentionHref);
  const stable = await owner.request.get(mentionHref, { maxRedirects: 0 });
  expect(stable.status()).toBe(302);
  expect(stable.headers().location).toBe(`/u/${RENAMED}`);
  await owner.goto(`/u/${MEMBER}`);
  await expect(owner).toHaveURL(new RegExp(`/u/${RENAMED}$`));
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText(`@${RENAMED}`);
  await ownPage(RENAMED);
});

test("member topics paginate 20 at a time, keep original language, and require membership", async () => {
  const fixture = JSON.parse(fs.readFileSync(`${state().dir}/member-pagination.json`, "utf8")) as { handle: string; count: number };
  await owner.goto(`/u/${fixture.handle}`);
  await expect(owner.locator("#posts li")).toHaveCount(20);
  await expect(owner.locator('#posts span[lang="ja"]')).toHaveCount(20);
  await expect(owner.getByRole("link", { name: en.member_page_write_intro, exact: true })).toHaveCount(0);
  await expectMemberPageOnly(owner);
  const first = await owner.locator("#posts li > a").evaluateAll(links => links.map(link => link.getAttribute("href")));
  await owner.getByRole("link", { name: en.page_next, exact: true }).click();
  await expect(owner).toHaveURL(new RegExp(`/u/${fixture.handle}\\?page=2#posts$`));
  await expect(owner.locator("#posts li")).toHaveCount(fixture.count - first.length);
  const second = await owner.locator("#posts li > a").evaluateAll(links => links.map(link => link.getAttribute("href")));
  expect(second.some(href => first.includes(href))).toBe(false);
  await owner.getByRole("link", { name: en.page_prev, exact: true }).click();
  await expect(owner.locator("#posts li")).toHaveCount(20);
  const response = await owner.request.get(`/u/${RENAMED}`);
  expect(response.headers()["cache-control"]).toContain("private");
  expect((await owner.request.get(`/u/${RENAMED}.md`)).status()).toBe(404);
  const anonymous = await request.newContext({ baseURL: state().baseURL, extraHTTPHeaders: clientHeaders("10.8.41.3") });
  try {
    const res = await anonymous.get(`/u/${RENAMED}`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(new URL(res.headers().location, state().baseURL).pathname).toBe("/login");
  } finally { await anonymous.dispose(); }
});
