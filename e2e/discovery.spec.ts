import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { messagePattern, formatMessage, clientHeaders, enMessages as en, jaMessages as ja, logSize, mailFor, signUp, visitListRow, state, waitForFormReady } from "./helpers";

// one connected discovery and return journey, with real browser languages and independent members.
test.describe.configure({ mode: "serial" });

const AKI = "disco_aki";
const BEN = "disco_ben";
const AKI_EMAIL = `${AKI}@example.com`;
const BEN_EMAIL = `${BEN}@example.com`;
const BODY = `発見の入口 @${BEN} 一緒にこの場を読もう。`;
const BEN_REPLY = "I found the invitation and would like to join this conversation.";
const AKI_REPLY = "最初の返事。異なる言語でも話し続けられる。";
const NEW_BODY = "次の発見。別の画面を勝手に並べ替えない。";
const LANGUAGE_NAMES = ["日本語", "English", "Français", "Deutsch", "繁體中文", "简体中文", "한국어", "ไทย", "Tiếng Việt"];

let akiContext: BrowserContext;
let benContext: BrowserContext;
let aki: Page;
let ben: Page;
let topicId: string;
let newTopicId: string;

const cards = (page: Page) => page.locator("main li[id^='q-']");
const card = (page: Page, id: string) => page.locator(`li#q-${id}`);
const composer = (page: Page) => page.locator("form", { has: page.locator("textarea[name='body']") });

async function expectNoLanguageCounts(page: Page) {
  // Inspect reaction controls and individual list metadata items, excluding article provenance.
  const texts = await page.locator("[data-article-actions], [data-reply-actions], main li[id^='q-'] [data-meta-item]").allInnerTexts();
  for (const text of texts) for (const name of LANGUAGE_NAMES) {
    expect(text, `no per-language counts for ${name}`).not.toMatch(new RegExp(`${name}\\s*[:：]?\\s*\\d`));
  }
}

async function postBody(page: Page, body: string, messages: typeof en): Promise<string> {
  await page.goto("/t/new");
  await waitForFormReady(composer(page));
  await composer(page).getByLabel(messages.field_body, { exact: true }).fill(body);
  await composer(page).getByRole("button", { name: messages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function reply(page: Page, body: string, messages: typeof en) {
  await page.goto(`/t/${topicId}`);
  const form = page.locator("form", { has: page.getByRole("button", { name: messages.submit_reply, exact: true }) });
  await waitForFormReady(form);
  await form.locator("textarea[name='body']").fill(body);
  await form.getByRole("button", { name: messages.submit_reply, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/t/${topicId}` && /^[1-9]\d*$/.test(url.searchParams.get("posted") ?? "") && url.hash === `#c-${url.searchParams.get("posted")}`);
  await expect(page.locator("#replies")).toContainText(body);
}

async function expectCardOnly(scope: Locator) {
  await expect(scope.locator("form[action*='report'], form[action*='delete']")).toHaveCount(0);
  await expect(scope.locator("a[href$='/edit'], a[href*='/report']")).toHaveCount(0);
  await expect(scope.getByText(BEN_REPLY, { exact: true })).toHaveCount(0);
  await expect(scope.getByText(AKI_REPLY, { exact: true })).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  akiContext = await browser.newContext({ locale: "ja-JP", extraHTTPHeaders: clientHeaders("10.8.35.1") });
  benContext = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.35.2") });
  aki = await akiContext.newPage();
  ben = await benContext.newPage();
});

test.afterAll(async () => {
  await akiContext?.close();
  await benContext?.close();
});

// Keep the connected journey and its privacy checks; individual behaviors live in their feature suites.
test.afterEach(async () => {
  for (const page of [aki, ben]) if (page && !page.isClosed() && page.url() !== "about:blank") await expectNoLanguageCounts(page);
});

test("a bilingual discovery journey signs up, reads a mention, replies, follows and returns through notifications", async () => {
  await signUp(aki, state().discoveryAkiInvite, AKI_EMAIL, { handle: AKI });
  await signUp(ben, state().discoveryBenInvite, BEN_EMAIL, { handle: BEN });
  const since = logSize();
  topicId = await postBody(aki, BODY, ja);
  const mail = await mailFor(BEN_EMAIL, since, messagePattern(en.mail_subject_mention, { handle: /.+/ }));
  const entry = mail.text.match(new RegExp(`https?://[^\\s]+/t/${topicId}(?:#[^\\s]+)?`))?.[0];
  expect(entry).toBeDefined();
  await ben.goto(entry!);
  await expect(ben.locator("[data-reading-body]").first()).toContainText("発見の入口");
  await reply(ben, BEN_REPLY, en);
  await expect(ben.getByRole("button", { name: en.follow_unfollow, exact: true })).toBeVisible();
  await reply(aki, AKI_REPLY, ja);
  await reply(aki, "二つ目の返事。未読の通知は一つにまとまる。", ja);
  await ben.goto("/notifications");
  // The unread mention, the first reply and the later ones are one row for the post; it opens at the first unread reply.
  const grouped = ben.locator("li").filter({ has: ben.locator('a[href*="group=thread"]') });
  await expect(grouped).toHaveCount(1);
  await expect(grouped).toContainText(`@${AKI}`);
  await grouped.getByRole("link").first().click();
  await expect(ben).toHaveURL(new RegExp(`/t/${topicId}(?:\\?sl=en)?#c-\\d+$`));
  await expect(ben.locator("#replies")).toContainText(AKI_REPLY);
});

test("8: translated rows omit bodies, keep their order until reload and link to the latest reply", async () => {
  const topic = card(ben, topicId);
  await expect(async () => {
    await ben.goto("/");
    await expect(topic.locator(":scope > a")).toContainText("[en]", { timeout: 3_000 });
    await expect(topic.getByText(messagePattern(en.label_from_lang_machine, { lang: /\S+/ }))).toBeVisible({ timeout: 3_000 });
    await expect(topic.getByText(formatMessage(en.label_machine, { engine: en.engine_fake }), { exact: true })).toHaveCount(0);
  }).toPass({ timeout: 60_000 });
  await expect(topic.locator(".longread, .line-clamp-2, form[action='/vote'], form[action='/follow']")).toHaveCount(0);
  await expectCardOnly(topic);
  const initialOrder = await cards(ben).evaluateAll(els => els.map(el => el.id));
  newTopicId = await postBody(aki, NEW_BODY, ja);
  await expect(card(ben, newTopicId)).toHaveCount(0);
  expect(await cards(ben).evaluateAll(els => els.map(el => el.id))).toEqual(initialOrder);
  await ben.reload();
  await expect(card(ben, newTopicId)).toBeVisible();
  const reloadedOrder = await cards(ben).evaluateAll(els => els.map(el => el.id));
  expect(reloadedOrder.indexOf(`q-${newTopicId}`)).toBeLessThan(reloadedOrder.indexOf(`q-${topicId}`));
  await topic.getByRole("link", { name: formatMessage(en.home_replies, { count: 3 }), exact: true }).click();
  await expect(ben).toHaveURL(new RegExp(`/t/${topicId}(?:\\?sl=en)?#c-\\d+$`));
  await expect(ben.locator("#replies article")).toHaveCount(3);
});

test("12: without JavaScript a title row opens the thread and its original", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", javaScriptEnabled: false, storageState: await benContext.storageState(), extraHTTPHeaders: clientHeaders("10.8.35.3") });
  try {
    const page = await context.newPage();
    await visitListRow(page, "/", card(page, topicId));
    await card(page, topicId).locator(":scope > a").click();
    await expect(page).toHaveURL(new RegExp(`/t/${topicId}(?:\\?sl=[\\w-]+)?$`));
    await page.locator("article").first().getByRole("link", { name: en.show_original, exact: true }).click();
    await expect(page.locator("article").first().locator(".longread")).toContainText(BODY);
    await expect(page.locator("article").first().locator(".longread")).toHaveAttribute("lang", "ja");
    await expectNoLanguageCounts(page);
  } finally { await context.close(); }
});
