import { openTranslationSettings } from "./helpers";
import { readTopicTranslation } from "./helpers";
import { captureListRows } from "./support/list-rows-evidence";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, enMessages, formatMessage, insightfulCountPattern, messagePattern, clientHeaders, signUp, state, messageTitleField as titleField, waitForFormReady } from "./helpers";

// Exercise signup, posting, translation display, replies, votes, display language, list pagination, settings and operator metrics in a browser.
// Share one server and DB; run serially because tests use earlier results.
test.describe.configure({ mode: "serial" });

const TITLE = "AIの安全性について";
const BODY = "これは最初の投稿です。\n\n整合性について議論したい。";

let hanaContext: BrowserContext;
let somchaiContext: BrowserContext;
let hana: Page;
let somchai: Page;
let topicPath: string;

test.beforeAll(async ({ browser }) => {
  hanaContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.2.0.1") });
  somchaiContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.2.0.2") });
  hana = await hanaContext.newPage();
  somchai = await somchaiContext.newPage();
});

test.afterAll(async () => {
  await hanaContext.close();
  await somchaiContext.close();
});

// Mark the JavaScript page state to detect navigation: a new document loses the marker.
const mark = (page: Page) => page.evaluate(() => ((window as unknown as { __kept?: boolean }).__kept = true));
const marked = (page: Page) => page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);
const topicArticle = (page: Page) => page.locator("article").first();

test("an invited member logs in with a magic link, sets up a profile and posts a topic", async () => {
  await signUp(hana, state().invite, "hana@example.com", { handle: "hana", mainLang: "ja" });
  await hanaContext.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await hana.reload();
  await hana.getByRole("link", { name: enMessages.nav_new_topic }).click();
  await waitForFormReady(hana.locator("form", { has: titleField(hana) }));
  await titleField(hana).fill(TITLE);
  await hana.getByLabel(enMessages.field_body).fill(BODY);
  await hana.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(hana.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  topicPath = new URL(hana.url()).pathname;
  expect(topicPath).toMatch(/^\/t\/\d+$/);
});

test("the member invites another member in a different home area, who signs up", async () => {
  await hana.goto("/invites/new");
  await waitForClientRoute(hana);
  await hana.getByRole("checkbox", { name: enMessages.invites_bulk_send_email, exact: true }).uncheck();
  await hana.getByLabel(enMessages.invites_bulk_emails, { exact: true }).fill("somchai@example.com");
  await hana.getByRole("button", { name: enMessages.invites_bulk_submit, exact: true }).click();
  const invite = await hana.locator("code").innerText();
  expect(invite).toContain("/invite/");
  expect(await hana.getByLabel(enMessages.invites_message_label, { exact: true }).inputValue()).toContain(invite);
  await expect(hana.getByRole("button", { name: enMessages.invites_copy_message, exact: true })).toBeVisible();
  await signUp(somchai, invite, "somchai@example.com", { handle: "somchai", mainLang: "th" });
  await somchaiContext.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await somchai.reload();
  await expect(async () => {
    await somchai.goto(topicPath);
    await expect(topicArticle(somchai).getByRole("heading", { level: 1 })).toHaveText(`[en] ${TITLE}`, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await somchai.goto("/settings");
  await waitForClientRoute(somchai);
  await openTranslationSettings(somchai);
  await somchai.getByRole("combobox", { name: enMessages.display_lang_label, exact: true }).selectOption("th");
  await expect(somchai.locator("#settings-display-lang").getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(somchai.getByText(enMessages.settings_saved, { exact: true }).first()).toBeVisible();
});

test("the home is one stream of the topics of every language, newest first, each row naming the language of its original; there is no Latest link", async () => {
  await hana.goto("/");
  await expect(hana.getByRole("heading", { level: 1, name: enMessages.home_unified_title })).toBeVisible();
  const first = hana.locator("main li[id^=q-]").filter({ has: hana.getByRole("link", { name: TITLE, exact: true }) });
  await expect(first.getByRole("link", { name: TITLE, exact: true })).toBeVisible();
  await expect(first.getByText(enMessages.language_name_ja, { exact: true })).toBeVisible();
  await expect(first.getByText("@hana")).toBeVisible();
  // No folded ordering rule in the order row: the selected order says what the list is.
  await expect(hana.locator("main .more-info")).toHaveCount(0);
  await expect(hana.getByRole("link", { name: enMessages.home_order_created })).toHaveAttribute("aria-current", "page");
  await expect(hana.locator('header a[href="/latest"]')).toHaveCount(0);
  // A member whose main language is Thai sees the same stream.
  await somchai.goto("/");
  await expect(somchai.getByRole("heading", { level: 1, name: enMessages.home_unified_title })).toBeVisible();
  expect(await somchai.locator("main li[id^=q-]").count()).toBeGreaterThan(1);
  await expect(somchai.getByText(enMessages.home_empty)).toHaveCount(0);
});

test("a translated title row opens the thread, where originals and translations still toggle", async () => {
  const row = () => somchai.locator("main li[id^=q-]", { has: somchai.getByRole("link", { name: `[th] ${TITLE}`, exact: true }) });
  await expect(async () => {
    await somchai.goto("/");
    await expect(row()).toBeVisible({ timeout: 3_000 });
    await expect(row().getByText(messagePattern(enMessages.label_from_lang_machine, { lang: /\S+/ }))).toBeVisible({ timeout: 3_000 });
    await expect(row().getByText(formatMessage(enMessages.label_machine, { engine: enMessages.engine_fake }), { exact: true })).toHaveCount(0);
  }).toPass({ timeout: 60_000 });
  await expect(row().locator(".longread")).toHaveCount(0);
  await row().getByRole("link", { name: `[th] ${TITLE}`, exact: true }).click();
  await expect(somchai).toHaveURL(new RegExp(`${topicPath}(?:\\?sl=[\\w-]+)?$`));
  const article = topicArticle(somchai);
  await expect(article.getByRole("heading", { level: 1 })).toHaveText(`[th] ${TITLE}`);
  // The byline says once what is read ("AI-translated from Japanese (test engine)"); the model is its tooltip.
  const reading = article.locator("[data-reading-language] > span[title]");
  await expect(reading).toContainText(formatMessage(enMessages.label_from_lang_machine_engine, { lang: enMessages.language_name_ja, engine: enMessages.engine_fake }));
  await expect(reading).toHaveAttribute("title", "fake-1");
  await expect(article.locator("details.reading-lang-menu summary")).toHaveText(enMessages.reading_other_languages_read);
  await expect(article.getByText("[th] これは最初の投稿です。")).toBeVisible();
  await mark(somchai);
  await article.getByRole("link", { name: enMessages.show_original }).click();
  await expect(article.getByRole("heading", { level: 1 })).toHaveText(TITLE);
  await expect(article.locator("details.reading-lang-menu summary")).toHaveText(enMessages.reading_other_languages_read);
  await expect(article.getByText("整合性について議論したい。")).toBeVisible();
  expect(await marked(somchai)).toBe(true);
  await readTopicTranslation(article, "th");
  await expect(article.getByRole("heading", { level: 1 })).toHaveText(`[th] ${TITLE}`);
  await expect(article.locator("details.reading-lang-menu summary")).toHaveText(enMessages.reading_other_languages_read);
  expect(await marked(somchai)).toBe(true);
});

test("a reader taps 'This translation has a problem' once, and another reader then sees a small notice on that translation", async () => {
  await somchai.goto(topicPath);
  const article = topicArticle(somchai);
  // One press reports the translation of the body. The title is a report of its own, and the choice of the part opens only when both are reported.
  await expect(article.getByRole("combobox")).toHaveCount(0);
  await article.getByRole("button", { name: enMessages.report_button, exact: true }).click();
  await expect(somchai.getByText(enMessages.report_thanks)).toBeVisible();
  await expect(article.getByRole("combobox")).toHaveCount(0);
  await article.getByRole("button", { name: enMessages.report_title_button, exact: true }).click();
  await expect(article.getByRole("button", { name: enMessages.report_reported, exact: true })).toHaveCount(2);
  const field = article.locator('form:has(input[name="intent"][value="report-details"]) input[name="field"]');
  await article.getByRole("combobox").click();
  const choices = somchai.getByRole("listbox");
  await expect(choices.getByRole("option")).toHaveText([enMessages.report_field_body, enMessages.report_field_title]);
  await choices.getByRole("option", { name: enMessages.report_field_title, exact: true }).click();
  await expect(field).toHaveValue("title");
  await article.getByRole("combobox").click();
  await choices.getByRole("option", { name: enMessages.report_field_body, exact: true }).click();
  await expect(field).toHaveValue("body");
  // A reported translation shows a small notice to other readers too. Without a retry model in the dev server, reports go directly to operators and the notice stays "指摘があります".
  const id = topicPath.split("/").pop();
  await hana.goto(`${topicPath}?lang=th&tr=${id}`);
  await expect(topicArticle(hana).getByRole("note")).toHaveText(enMessages.report_notice_open);
  // No notice on the original.
  await hana.goto(topicPath);
  await expect(topicArticle(hana).getByRole("note")).toHaveCount(0);
});

test("the reply form is empty after a reply is sent", async () => {
  await somchai.goto(topicPath);
  const form = somchai.locator("#reply form");
  await form.getByLabel(enMessages.field_body).fill("ขอบคุณครับ");
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(somchai).toHaveURL(/#c-\d+$/);
  await expect(somchai.locator("article").nth(1).getByText("ขอบคุณครับ")).toBeVisible();
  await expect(somchai.locator("#reply form").getByLabel(enMessages.field_body)).toHaveValue("");
});

test("Insightful is toggled without leaving the page and shown as a total with the number of languages, never per language", async () => {
  await somchai.goto(topicPath);
  const article = topicArticle(somchai);
  await mark(somchai);
  // The button is named Insightful; it says what it means, and is pressed or not (aria-pressed)
  const button = article.getByRole("button", { name: enMessages.insightful_give, exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.hover();
  await expect(somchai.getByRole("tooltip")).toHaveText(enMessages.insightful_help);
  await expect(article.getByText(insightfulCountPattern(), { exact: true })).toHaveCount(0);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(article.getByText(formatMessage(enMessages.insightful_count_short, { total: 1, langs: 1 }), { exact: true })).toBeVisible();
  expect(await marked(somchai)).toBe(true);
  // No count per language, no language name next to a number, no cross-area badge, no vote wording
  const text = await article.locator("[data-article-actions]").innerText();
  expect(text).not.toMatch(/Votes?\b|Cross-area/);
  expect(text).not.toMatch(/(日本語|English|ไทย)\s*[:：]?\s*\d/);

  // The author (Japanese) sees the count of the post and has no button on their own post. A reply can be pressed: from another language it is "1 (1 language)" too
  await hana.goto(topicPath);
  await waitForClientRoute(hana);
  const own = topicArticle(hana);
  await expect(own.getByText(formatMessage(enMessages.insightful_count, { total: 1, langs: 1 }))).toBeVisible();
  await expect(own.getByRole("button", { name: enMessages.insightful_give, exact: true })).toHaveCount(0);
  const reply = hana.locator("article").nth(1);
  await reply.getByRole("button", { name: enMessages.insightful_give, exact: true }).click();
  await expect(reply.getByRole("button", { name: enMessages.insightful_give, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(reply.getByText(formatMessage(enMessages.insightful_count_short, { total: 1, langs: 1 }), { exact: true })).toBeVisible();
  // The topic is not a question, so there is no stance and no 'Reconsider my stance' link
  await expect(hana.getByRole("link", { name: enMessages.insightful_review })).toHaveCount(0);

  // The list shows the count of the topic (the total and the number of languages) too, and the card of the home has the button for the others
  await hana.goto("/latest");
  await expect(hana.getByRole("listitem").filter({ hasText: TITLE }).getByText(formatMessage(enMessages.insightful_count, { total: 1, langs: 1 }))).toBeVisible();
  await hana.goto("/");
  const ownCard = hana.locator("main li[id^=q-]").filter({ has: hana.getByRole("link", { name: TITLE, exact: true }) });
  await expect(ownCard.getByText(formatMessage(enMessages.insightful_count, { total: 1, langs: 1 }))).toBeVisible();
  await expect(ownCard.getByRole("button", { name: enMessages.insightful_give, exact: true })).toHaveCount(0);

  // Removing it takes the count away
  await somchai.goto(topicPath);
  await mark(somchai);
  await article.getByRole("button", { name: enMessages.insightful_give, exact: true }).click();
  await expect(article.getByRole("button", { name: enMessages.insightful_give, exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(article.getByText(insightfulCountPattern(), { exact: true })).toHaveCount(0);
  expect(await marked(somchai)).toBe(true);
});

test("choosing a display language changes what is shown", async () => {
  await somchai.goto(topicPath);
  await expect(topicArticle(somchai).getByRole("heading", { level: 1 })).toHaveText(`[th] ${TITLE}`);
  await somchai.goto("/settings");
  await waitForClientRoute(somchai);
  await openTranslationSettings(somchai);
  await somchai.getByRole("combobox", { name: enMessages.display_lang_label, exact: true }).selectOption("en");
  await expect(somchai.locator("#settings-display-lang").getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(somchai.getByText(enMessages.settings_saved, { exact: true }).first()).toBeVisible();
  await somchai.goto(topicPath);
  await expect(topicArticle(somchai).getByRole("heading", { level: 1 })).toHaveText(`[en] ${TITLE}`);
  await expect(topicArticle(somchai).getByText("[en] これは最初の投稿です。")).toBeVisible();
  // The saved setting applies on other pages too.
  await somchai.goto("/latest");
  await expect(somchai.getByRole("link", { name: `[en] ${TITLE}` })).toBeVisible();
  await somchai.goto("/settings");
  await waitForClientRoute(somchai);
  await openTranslationSettings(somchai);
  await somchai.getByRole("combobox", { name: enMessages.display_lang_label, exact: true }).selectOption("th");
  await expect(somchai.locator("#settings-display-lang").getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(somchai.getByText(enMessages.settings_saved, { exact: true }).first()).toBeVisible();
  await somchai.goto("/latest");
  await expect(somchai.getByRole("link", { name: `[th] ${TITLE}` })).toBeVisible();
});

test("the home is paged 30 rows at a time with ?page=, and keeps the order and the filter in the links", async () => {
  await hana.goto("/");
  await expect(hana.locator("main li[id^=q-]")).toHaveCount(30);
  const firstPage = await rowIds(hana);
  await expect(hana.getByRole("link", { name: TITLE, exact: true })).toBeVisible();
  await hana.getByRole("link", { name: enMessages.page_next }).click();
  await expect(hana).toHaveURL(/\?page=2$/);
  await waitForClientRoute(hana);
  expect(await hana.locator("main li[id^=q-]").count()).toBeGreaterThan(0);
  expect((await rowIds(hana)).some(id => firstPage.includes(id))).toBe(false);
  await hana.getByRole("link", { name: enMessages.page_prev }).click();
  await expect(hana.locator("main li[id^=q-]")).toHaveCount(30);
  // The order and the filter go with the page links
  await hana.goto("/?order=activity&long=1");
  await expect(hana.getByRole("link", { name: enMessages.home_order_activity })).toHaveAttribute("aria-current", "page");
  const filter = hana.locator(`summary[aria-label^="${enMessages.filter_prefix}"]`);
  await expect(filter).toHaveText(enMessages.home_filter_long);
  await filter.click();
  await expect(hana.getByRole("link", { name: enMessages.home_filter_long })).toHaveAttribute("aria-current", "true");
  await expect(hana.getByRole("link", { name: enMessages.page_next })).toHaveAttribute("href", "/?order=activity&long=1&page=2");
  // /latest keeps its own pages of 30.
  const latest = await hana.goto("/latest?page=2");
  expect(latest?.status()).toBe(200);
  expect((await hana.goto("/latest?page=0"))?.status()).toBe(404);
  expect((await hana.goto("/?order=nonsense"))?.status()).toBe(400);
});

test("/a/:lang lists the topics of one original language and answers 404 for an unknown language", async () => {
  await hana.goto("/a/ja");
  await expect(hana.getByRole("heading", { level: 1, name: formatMessage(enMessages.area_title, { lang: "日本語" }) })).toBeVisible();
  await expect(hana.getByRole("link", { name: TITLE })).toBeVisible();
  await hana.goto("/a/th");
  await expect(hana.getByRole("heading", { level: 1, name: formatMessage(enMessages.area_title, { lang: "ไทย" }) })).toBeVisible();
  await expect(hana.getByRole("link", { name: TITLE, exact: true })).toHaveCount(0);
  expect((await hana.goto("/a/xx"))?.status()).toBe(404);
  // Switch original language from a language list.
  await hana.goto("/a/ja");
  await hana.locator("summary:has(h1)").click();
  await hana.getByRole("navigation", { name: enMessages.home_origlang_label }).getByRole("link", { name: "Tiếng Việt" }).click();
  await expect(hana).toHaveURL(/\/a\/vi$/);
});

test("the main language can be changed once right after signup, then not for 90 days", async () => {
  await somchai.goto("/settings");
  await waitForClientRoute(somchai);
  await expect(somchai.getByRole("combobox", { name: enMessages.onboarding_home_area, exact: true })).toHaveValue("th");
  // The first change is always allowed; no next-change date is shown.
  await expect(somchai.getByText(messagePattern(enMessages.settings_area_next, { date: /\d{4}-\d{2}-\d{2}/ }))).toHaveCount(0);
  await somchai.getByRole("combobox", { name: enMessages.onboarding_home_area, exact: true }).selectOption("vi");
  await somchai.getByRole("checkbox", { name: formatMessage(enMessages.settings_area_confirm, { days: 90 }), exact: true }).check();
  await somchai.locator("#settings-area").getByRole("button", { name: enMessages.settings_area_change, exact: true }).click();
  await expect(somchai.getByText(enMessages.settings_saved).first()).toBeVisible();
  await expect(somchai.getByRole("combobox", { name: enMessages.onboarding_home_area, exact: true })).toHaveValue("vi");
  // After changing, show the next allowed date (90 days later) and hide the form.
  const next = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await expect(somchai.getByText(formatMessage(enMessages.settings_area_next, { date: next }))).toBeVisible();
  await expect(somchai.getByRole("combobox", { name: enMessages.onboarding_home_area, exact: true })).toBeDisabled();
  // Language preferences can still be changed.
  await somchai.getByRole("group", { name: enMessages.onboarding_read_langs }).getByRole("checkbox", { name: "日本語", exact: true }).check();
  await expect(somchai.locator("#settings-read-langs").getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(somchai.getByText(enMessages.settings_saved).first()).toBeVisible();
});

test("the observation metrics are for the operator only", async () => {
  await hana.goto("/admin/metrics");
  await expect(hana.getByRole("heading", { level: 1, name: enMessages.metrics_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.metrics_cross_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.metrics_writers_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.metrics_reports_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.metrics_ai_title })).toBeVisible();
  // The help line says that only posts with a value are counted.
  await expect(hana.getByText(enMessages.metrics_ai_help)).toBeVisible();
  expect((await somchai.goto("/admin/metrics"))?.status()).toBe(404);
});

test("the observation page and the data exports: the operator downloads the observation data, members their own data", async () => {
  // Observation screen: operators only.
  await hana.goto("/admin/observation");
  await expect(hana.getByRole("heading", { level: 1, name: enMessages.observation_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.observation_conformity_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.observation_diversity_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.observation_ai_title })).toBeVisible();
  await expect(hana.getByRole("heading", { name: enMessages.observation_div_title })).toBeVisible();
  expect((await somchai.goto("/admin/observation"))?.status()).toBe(404);
  // Observation export is JSON without email addresses, handles, titles or bodies.
  const exported = await hana.request.get("/admin/export");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["cache-control"]).toBe("no-store");
  expect(exported.headers()["content-disposition"]).toMatch(/^attachment; filename="tomola-observation-/);
  const text = await exported.text();
  const data = JSON.parse(text);
  expect(data.format).toBe("tomola-observation-export");
  expect(data.entries.length).toBeGreaterThan(30);
  for (const needle of ["@example.com", "hana", "somchai", TITLE, "整合性について議論したい"]) expect(text, needle).not.toContain(needle);
  expect((await somchai.request.get("/admin/export")).status()).toBe(404);
  // Personal member export contains their own posts, replies and votes, not other members' email addresses or posts.
  const mine = await somchai.request.get("/settings/export");
  expect(mine.status()).toBe(200);
  const own = await mine.json();
  expect(own.profile.handle).toBe("somchai");
  expect(own.entries.map((e: { body: string }) => e.body)).toEqual(["ขอบคุณครับ"]);
  expect(JSON.stringify(own)).not.toContain("hana");
  expect(JSON.stringify(own)).not.toContain("@example.com");
  // Download through the settings-page link.
  await somchai.goto("/settings");
  await somchai.locator("#settings-advanced > summary").click();
  await expect(somchai.getByRole("link", { name: enMessages.settings_export_link })).toHaveAttribute("href", "/settings/export");
});

test("a topic without a title is posted from /t/new, headed by the beginning of its body, listed by it, and has no title in its Markdown twin", async () => {
  const REMARK = "朝のうちは涼しかったのに、昼には暑くなった。";
  await hana.goto("/t/new");
  // The title is optional; ticking "Ask for stances" makes it required (the browser's check, with JavaScript).
  await expect(titleField(hana)).not.toHaveAttribute("required", "");
  await hana.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await expect(titleField(hana)).toHaveAttribute("required", "");
  await hana.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).uncheck();
  await expect(titleField(hana)).not.toHaveAttribute("required", "");
  await hana.getByLabel(enMessages.field_body).fill(`${REMARK}\n\n二段落目です。`);
  await hana.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(hana.getByRole("heading", { level: 1, name: REMARK })).toBeVisible();
  await expect(hana).toHaveTitle(REMARK);
  const path = new URL(hana.url()).pathname;
  expect(path).toMatch(/^\/t\/\d+$/);
  await expect(topicArticle(hana).getByText("二段落目です。")).toBeVisible();
  // The row uses the opening of the body as its title.
  await hana.goto("/latest");
  await expect(hana.getByRole("link", { name: REMARK })).toBeVisible();
  await hana.goto("/");
  const card = hana.locator("main li[id^=q-]").first();
  await expect(card.getByText(REMARK)).toBeVisible();
  await expect(card.getByRole("heading")).toHaveCount(0);
  // The Markdown twin has no title key.
  const twin = await hana.request.get(`${path}.md`);
  expect(twin.status()).toBe(200);
  const text = await twin.text();
  expect(text).not.toMatch(/^title:/m);
  expect(text).toContain("二段落目です。");
  // The translation of the body gives the heading of the translated page (the fake engine of the dev server translates the body only; there is no title row).
  const id = path.split("/").pop();
  await expect(async () => {
    await somchai.goto(`${path}?lang=th&tr=${id}`);
    await expect(topicArticle(somchai).getByRole("heading", { level: 1 })).toHaveText(`[th] ${REMARK}`, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(somchai).toHaveTitle(`[th] ${REMARK}`);
});

// Home rows, the dedicated editor, and compact stance controls.
const rowIds = (page: Page) => page.locator("main li[id^=q-]").evaluateAll(els => els.map(el => el.id));
let newQuestion: string;

test("a dedicated question editor retains rejected input and accepts a title from frontmatter", async () => {
  await hana.goto("/t/new");
  const form = hana.locator("form", { has: titleField(hana) });
  await waitForFormReady(form);
  await form.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await form.getByLabel(enMessages.field_body, { exact: true }).fill("---\nlang: en\n---\nThe frontmatter has no title.");
  await expect(titleField(hana)).not.toHaveAttribute("required", "");
  await form.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(form.getByText(enMessages.error_title, { exact: true })).toBeVisible();
  await expect(form.getByLabel(enMessages.field_body, { exact: true })).toHaveValue("---\nlang: en\n---\nThe frontmatter has no title.");
  await waitForFormReady(form);
  await form.getByLabel(enMessages.field_body, { exact: true }).fill("---\ntitle: Title from the frontmatter\nlang: en\n---\nThe body.");
  await form.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(hana.getByRole("heading", { level: 1, name: "Title from the frontmatter", exact: true })).toBeVisible();
  newQuestion = new URL(hana.url()).pathname.split("/").at(-1)!;
});

test("without scripts the home remains readable through title rows", async ({ browser }) => {
  const context = await browser.newContext({ storageState: await hanaContext.storageState(), javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.2.0.4") });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator(`li#q-${newQuestion}`).getByRole("link", { name: "Title from the frontmatter", exact: true })).toBeVisible();
    await expect(page.locator("textarea, main article")).toHaveCount(0);
  } finally { await context.close(); }
});

test("order and filters keep screen and Markdown IDs aligned", async () => {
  // Match the ordinary-member audience of the Markdown list; operators
  // can additionally see hidden fixtures on HTML lists.
  await somchai.goto("/?order=activity");
  await expect(somchai.getByRole("link", { name: enMessages.home_order_activity, exact: true })).toHaveAttribute("aria-current", "page");
  await somchai.goto("/?asks=1");
  expect(await somchai.locator("main li[id^=q-]").count()).toBeGreaterThan(0);
  await expect(somchai.locator("main li[id^=q-]").filter({ hasNot: somchai.getByText(enMessages.question_badge, { exact: true }) })).toHaveCount(0);
  for (const query of ["", "?order=activity", "?asks=1", "?long=1&order=activity"]) {
    await somchai.goto(`/${query}`);
    const screen = (await rowIds(somchai)).map(id => id.replace(/^q-/, ""));
    const md = await (await somchai.request.get(`/home.md${query}`)).text();
    expect([...md.matchAll(/^- id: p-(\d+)/gm)].map(m => m[1]), query).toEqual(screen);
    expect(md).not.toContain("<p>");
  }
  await somchai.goto("/a/ja?order=activity&long=1");
  expect(await somchai.locator("main li[id^=q-]").count()).toBeGreaterThan(0);
  await expect(somchai.getByRole("link", { name: enMessages.home_order_activity })).toHaveAttribute("aria-current", "page");
});

test("home, language and following rows fit desktop and mobile widths", async () => {
  for (const [screen, url] of [["home", "/"], ["language", "/a/ja"], ["following", "/following?all=1"]]) {
    await hana.goto(url);
    await captureListRows(hana, screen);
  }
});
