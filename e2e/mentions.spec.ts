import { expect, request, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages, formatMessage, messagePattern, escapeRegex, clientHeaders, logSize, mailFor, state, messageTitleField as titleField, waitForClientRoute, waitForFormReady } from "./helpers";

// @mentions: the handle suggestions in the posting form, the member link, the notification and its mail, the reply that takes the place of a
// mention, and an edit that does not tell again. The server and the database are single and each test uses the result of the one before, so they run in order.
test.describe.configure({ mode: "serial" });

let meiContext: BrowserContext;
let benContext: BrowserContext;
let mei: Page;
let ben: Page;
let topicPath: string;
let benMentionHref: string;
let meiMentionHref: string;
const TITLE = "Who wants to look at the draft?";

test.beforeAll(async ({ browser }) => {
  meiContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.8.0.1") });
  benContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.8.0.2") });
  mei = await meiContext.newPage();
  ben = await benContext.newPage();
});
test.afterAll(async () => {
  await meiContext.close();
  await benContext.close();
});

const suggestions = (page: Page) => page.getByRole("listbox", { name: enMessages.mention_suggestions_label });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("mei invites ben; ben chooses immediate email", async () => {
  await useMember(mei, "mei@example.com");
  await useMember(ben, "ben@example.com", "/settings");
  const form = ben.locator("form", { has: ben.getByRole("radio", { name: enMessages.settings_email_immediate, exact: true }) });
  await form.getByRole("radio", { name: enMessages.settings_email_immediate, exact: true }).check();
  await expect(form.getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(ben.getByText(enMessages.settings_saved, { exact: true })).toBeVisible();
});

test("typing @ and a start of a handle in the body offers the members; the arrow keys and Enter put the handle in; Escape closes the list", async () => {
  await mei.goto("/t/new");
  const body = mei.getByLabel(enMessages.field_body);
  await body.click();
  const suggested = mei.waitForResponse(response => new URL(response.url()).pathname === "/mentions/suggest");
  await body.pressSequentially("Hello @b");
  const response = await suggested;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  await expect(suggestions(mei)).toBeVisible();
  await expect(suggestions(mei).getByRole("option", { name: "@ben", exact: true })).toBeVisible();
  await expect(body).toHaveAttribute("aria-autocomplete", "list");
  await expect(body).toHaveAttribute("aria-activedescendant", /.+/);
  // Escape closes it, and the text stays as it was.
  await body.press("Escape");
  await expect(suggestions(mei)).toBeHidden();
  await expect(body).toHaveValue("Hello @b");
  // Typing on asks again (the list shows what matches the new text); Enter takes the active suggestion.
  await body.pressSequentially("e");
  await expect(suggestions(mei).getByRole("option", { name: "@ben" })).toBeVisible();
  await body.press("ArrowDown");
  await body.press("Enter");
  await expect(body).toHaveValue("Hello @ben ");
  await expect(suggestions(mei)).toBeHidden();
  // Nobody is suggested for a start that is no handle, or that is the member's own.
  await body.pressSequentially("and @m");  // mei is the member who is typing: she is not suggested to herself
  await expect(suggestions(mei).getByRole("option")).toHaveCount(0);
  // Plain typing works as it is: finish the text and the title by hand.
  await body.pressSequentially("ei: please read the draft. Also @nobody, `@ben` and [@ben](https://example.com).");
  await waitForFormReady(mei.locator("form", { has: titleField(mei) }));
  await titleField(mei).fill(TITLE);
  // The preview links the named member through the public id.
  await mei.getByRole("button", { name: enMessages.preview }).click();
  const preview = mei.locator(".longread");
  // The author names herself too (@mei): emphasized like any member, and not notified.
  const mentions = preview.locator("a.mention");
  await expect(mentions).toHaveText(["@ben", "@mei"]);
  await expect(preview.locator("a a.mention")).toHaveCount(0);
  await expect(preview.locator("a")).toHaveCount(3);
  benMentionHref = (await mentions.nth(0).getAttribute("href"))!;
  meiMentionHref = (await mentions.nth(1).getAttribute("href"))!;
  expect(benMentionHref).toMatch(/^\/u\/id\/[a-z0-9]{12}$/);
  expect(meiMentionHref).toMatch(/^\/u\/id\/[a-z0-9]{12}$/);
  const benPage = await mei.request.get(benMentionHref);
  expect(benPage.status()).toBe(200);
  expect(new URL(benPage.url()).pathname).toBe("/u/ben");
  const meiPage = await mei.request.get(meiMentionHref);
  expect(meiPage.status()).toBe(200);
  expect(new URL(meiPage.url()).pathname).toBe("/u/mei");
});

test("the post links the named member's public id and mails the named member", async () => {
  const before = logSize();
  await mei.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(mei.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  topicPath = new URL(mei.url()).pathname;
  const mention = mei.locator("article a.mention");
  await expect(mention).toHaveText(["@ben", "@mei"]);
  await expect(mention.nth(0)).toHaveAttribute("href", benMentionHref);
  await expect(mention.nth(1)).toHaveAttribute("href", meiMentionHref);
  await expect(mei.locator("article a a.mention")).toHaveCount(0);
  // The linked spelling remains emphasized.
  const weights = await mention.first().evaluate(element => ({ mention: Number(getComputedStyle(element).fontWeight), longread: Number(getComputedStyle(element.closest(".longread")!).fontWeight) }));
  expect(weights.mention).toBeGreaterThan(weights.longread);
  // The mail goes out after the delay of the immediate mail (1 second in this test); the subject and text name the author and the topic, and the link opens the topic.
  const mail = await mailFor("ben@example.com", before, messagePattern(enMessages.mail_subject_mention, { handle: /.+/ }));
  expect(mail.subject).toBe(formatMessage(enMessages.mail_subject_mention, { handle: "mei" }));
  // The mail is in ben's language and shows the translation of the post when there is one (the fake engine marks it "[en]"): the mention is kept in it.
  expect(mail.text).toMatch(messagePattern(enMessages.mail_item_mention, { handle: "mei", title: new RegExp(`(?:\\[en\\] )?${escapeRegex(TITLE)}`), excerpt: /[\s\S]*/, url: /https?:\/\/\S+/ }));
  expect(mail.text).toContain("Hello @ben");
  expect(mail.text).toContain(`${state().baseURL}${topicPath}`);
  expect(mail.text).not.toMatch(/[?&]k=|token/i);
});

test("the named member sees the notification, opens the post, and the mention is emphasized there too", async () => {
  await ben.goto("/notifications");
  const item = ben.locator("li", { hasText: messagePattern(enMessages.notification_mention, { handle: "mei", title: /.+/ }) });
  await expect(item).toContainText(TITLE);
  const contentLink = item.getByRole("link", { name: messagePattern(enMessages.notification_mention, { handle: "mei", title: /.+/ }) });
  await expect(contentLink).toHaveAttribute("href", /^\/notifications\/\d+\/open$/);
  await expect(item.locator('a[href^="/u/"]')).toHaveCount(0);
  await contentLink.click();
  await expect(ben).toHaveURL(new RegExp(`${topicPath}(?:\\?sl=[\\w-]+)?$`));
  const mentions = ben.locator("article a.mention");
  await expect(mentions).toHaveText(["@ben", "@mei"]);
  await expect(mentions.nth(0)).toHaveAttribute("href", benMentionHref);
  await expect(mentions.nth(1)).toHaveAttribute("href", meiMentionHref);
});

test("a reply that mentions the topic author tells her as a reply only, not twice (reply before mention)", async () => {
  const form = ben.locator("#reply form");
  await waitForFormReady(form);
  await form.getByLabel(enMessages.field_body).fill("Thanks @mei, I will read it. @mei");
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(ben).toHaveURL(/#c-\d+$/);
  await mei.goto("/notifications");
  await expect(mei.locator("li", { hasText: messagePattern(enMessages.notification_reply_to_topic_language, { handle: /.+/, title: /.+/, language: enMessages.language_name_en }) })).toHaveCount(1);
  await expect(mei.locator("li", { hasText: messagePattern(enMessages.notification_mention, { handle: /.+/, title: /.+/ }) })).toHaveCount(0);
});

test("an edit that removes the mention and writes it again does not tell the member again, and the edit form has the suggestions too", async () => {
  await mei.goto(`${topicPath}/edit`);
  await waitForFormReady(mei.locator("form", { has: mei.getByLabel(enMessages.field_body) }));
  const body = mei.getByLabel(enMessages.field_body);
  await body.fill("Nothing here for now.");
  await mei.getByRole("button", { name: enMessages.save_changes }).click();
  await expect(mei).toHaveURL(new RegExp(`${topicPath}(?:\\?sl=[\\w-]+)?$`));
  await waitForClientRoute(mei);
  await mei.goto(`${topicPath}/edit`);
  await waitForFormReady(mei.locator("form", { has: mei.getByLabel(enMessages.field_body) }));
  await body.fill("");
  await body.pressSequentially("Back again: @be");
  await expect(suggestions(mei).getByRole("option", { name: "@ben" })).toBeVisible();
  await suggestions(mei).getByRole("option", { name: "@ben" }).click();
  await expect(body).toHaveValue("Back again: @ben ");
  await mei.getByRole("button", { name: enMessages.save_changes }).click();
  await expect(mei).toHaveURL(new RegExp(`${topicPath}(?:\\?sl=[\\w-]+)?$`));
  await waitForClientRoute(mei);
  // (The topic is the first article of the page; ben's reply is the second.)
  const mention = mei.locator("article").first().locator("a.mention");
  await expect(mention).toHaveText(["@ben"]);
  await expect(mention).toHaveAttribute("href", benMentionHref);
  await ben.goto("/notifications");
  await expect(ben.locator("li", { hasText: messagePattern(enMessages.notification_mention, { handle: /.+/, title: /.+/ }) })).toHaveCount(1);
});

test("changing the mention query clears old suggestions before a delayed answer can be chosen", async ({ page }) => {
  await useMember(page, "query_change@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: page.getByLabel(enMessages.field_body) }));
  const body = page.getByLabel(enMessages.field_body);
  const pending = deferred();
  const arrived = deferred();
  const finished = deferred();
  await page.route("**/mentions/suggest?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "ha") {
      await route.fulfill({ json: { handles: ["hana"] } });
      return;
    }
    arrived.resolve();
    await pending.promise;
    await route.fulfill({ json: { handles: ["john"] } }).catch(() => {});
    finished.resolve();
  });
  try {
    await body.fill("@ha");
    await expect(suggestions(page).getByRole("option", { name: "@hana" })).toBeVisible();
    await body.fill("@jo");
    await arrived.promise;
    await expect(suggestions(page)).toBeHidden();
    await expect(body).not.toHaveAttribute("aria-activedescendant", /.+/);
    await body.press("Enter");
    await expect(body).toHaveValue("@jo\n");
    pending.resolve();
    await finished.promise;
    await expect(suggestions(page)).toBeHidden();
    await expect(body).toHaveValue("@jo\n");
  } finally {
    pending.resolve();
    await page.unroute("**/mentions/suggest?*");
  }
});

test("moving to another occurrence of the same query ignores the earlier delayed response", async ({ page }) => {
  await useMember(page, "query_occurrence@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: page.getByLabel(enMessages.field_body) }));
  // A fetch implementation can still resolve an obsolete request; the query/start/controller guard must hold even without cancellation by the browser.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).includes("/mentions/suggest") ? original(input, { ...init, signal: undefined }) : original(input, init);
  });
  const body = page.getByLabel(enMessages.field_body);
  const firstReady = deferred();
  const firstRelease = deferred();
  const secondReady = deferred();
  const secondRelease = deferred();
  let calls = 0;
  await page.route("**/mentions/suggest?*", async (route) => {
    if (++calls === 1) {
      firstReady.resolve();
      await firstRelease.promise;
      await route.fulfill({ json: { handles: ["hana"] } }).catch(() => {});
    } else {
      secondReady.resolve();
      await secondRelease.promise;
      await route.fulfill({ json: { handles: ["haru"] } }).catch(() => {});
    }
  });
  try {
    await body.fill("@ha and @ha");
    await body.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(3, 3);
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await firstReady.promise;
    await body.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    firstRelease.resolve();
    await secondReady.promise;
    await expect(suggestions(page)).toBeHidden();
    secondRelease.resolve();
    await expect(suggestions(page).getByRole("option")).toHaveText(["@haru"]);
    await body.press("Enter");
    await expect(body).toHaveValue("@ha and @haru ");
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await page.unroute("**/mentions/suggest?*");
  }
});
