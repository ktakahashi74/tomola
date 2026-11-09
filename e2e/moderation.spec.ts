import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages, formatMessage, messagePattern, openAdminMenu, clientHeaders, logSize, mailFor, state, messageTitleField as titleField, waitForFormReady } from "./helpers";

// Browser flow: report, hide, public moderation record, affected member's notification and appeal, reply notifications marked read and immediate notification email.
// Operator olga (OPERATOR_EMAILS in e2e/global-setup.ts) invites sam and reiko. Run serially because tests use earlier results.
test.describe.configure({ mode: "serial" });

const SPAM_TITLE = "安いサプリはこちら";
const SPAM_BODY = "今すぐ買ってください。SPAM-BODY-MARKER";
const FRIENDLY_TITLE = "友好的な話題";

let olgaContext: BrowserContext;
let samContext: BrowserContext;
let reikoContext: BrowserContext;
let olga: Page;
let sam: Page;
let reiko: Page;
let spamPath: string;
let friendlyPath: string;

test.beforeAll(async ({ browser }) => {
  olgaContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.4.0.1") });
  samContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.4.0.2") });
  reikoContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.4.0.3") });
  olga = await olgaContext.newPage();
  sam = await samContext.newPage();
  reiko = await reikoContext.newPage();
});

test.afterAll(async () => {
  await olgaContext.close();
  await samContext.close();
  await reikoContext.close();
});

async function invite(page: Page, email: string): Promise<string> {
  await page.goto("/invites/new");
  await page.getByLabel(enMessages.invites_email).fill(email);
  await page.getByRole("button", { name: enMessages.invites_submit }).click();
  return await page.locator("code").innerText();
}

async function postTopic(page: Page, title: string, body: string): Promise<string> {
  await page.getByRole("link", { name: enMessages.nav_new_topic }).click();
  await waitForFormReady(page.locator("form", { has: titleField(page) }));
  await titleField(page).fill(title);
  await page.getByLabel(enMessages.field_body).fill(body);
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  return new URL(page.url()).pathname;
}

test("the operator signs up and invites a member who posts spam and a member who reads", async () => {
  await useMember(olga, "olga@example.com");
  // Operators see moderation and role links in their admin menu.
  await openAdminMenu(olga);
  await expect(olga.getByRole("menuitem", { name: enMessages.nav_mod, exact: true })).toBeVisible();
  await expect(olga.getByRole("menuitem", { name: enMessages.nav_roles, exact: true })).toBeVisible();


  await useMember(sam, "sam@example.com");
  await useMember(reiko, "reiko@example.com");
  // Ordinary members cannot access moderation screens; do not reveal their existence.
  await expect(sam.getByRole("menuitem", { name: enMessages.nav_mod, exact: true })).toHaveCount(0);
  expect((await sam.goto("/mod"))?.status()).toBe(404);
  await sam.goto("/");
  spamPath = await postTopic(sam, SPAM_TITLE, SPAM_BODY);
});

test("a member reports the post, and a moderator hides it from the queue", async () => {
  await reiko.goto(spamPath);
  const article = reiko.locator("article").first();
  await article.locator("summary").filter({ hasText: enMessages.flag_summary }).click();
  await article.getByLabel(enMessages.flag_reason).click();
  await reiko.getByRole("listbox").getByRole("option", { name: enMessages.reason_spam, exact: true }).click();
  await article.getByLabel(enMessages.flag_note).fill("an advertisement");
  await article.getByRole("button", { name: enMessages.flag_submit }).click();
  // The post's tool row keeps its own empty live region, so the report notice is found by its text.
  await expect(article.getByRole("status").filter({ hasText: enMessages.flag_thanks })).toBeVisible();
  await expect(article.getByText(enMessages.flag_already_reported, { exact: true })).toBeVisible();
  await expect(article.getByRole("button", { name: enMessages.flag_submit })).toHaveCount(0);
  await reiko.reload();
  await expect(article.getByText(enMessages.flag_already_reported, { exact: true })).toBeVisible();
  await expect(article.getByRole("button", { name: enMessages.flag_submit })).toHaveCount(0);
  const duplicate = await reiko.request.post(spamPath, { form: { intent: "flag", entryId: spamPath.split("/").at(-1)!, reason: "spam" }, headers: { Origin: state().baseURL } });
  expect(duplicate.status()).toBe(409);
  // Own posts have no report field.
  await sam.goto(spamPath);
  await expect(sam.getByText(enMessages.flag_summary)).toHaveCount(0);

  // The operator queue shows the report reason and explanation, but not the reporter.
  await olga.goto("/mod");
  const card = olga.locator("section", { hasText: SPAM_TITLE });
  await expect(card).toBeVisible();
  await expect(card.getByText("an advertisement")).toBeVisible();
  await expect(olga.getByText("reiko")).toHaveCount(0); // The reporter appears nowhere on screen.
  await card.getByLabel(enMessages.mod_note).fill("advertisement, removed under the no-spam rule");
  await card.getByRole("button", { name: enMessages.mod_hide }).click();
  await expect(card).toHaveCount(0);
});

test("the hidden post is a placeholder for members and shown with a mark to its author; it leaves the lists", async () => {
  await reiko.goto(spamPath);
  await expect(reiko.getByText(enMessages.entry_hidden_placeholder)).toBeVisible();
  await expect(reiko.getByRole("heading", { level: 1, name: SPAM_TITLE })).toHaveCount(0);
  await expect(reiko.getByText("SPAM-BODY-MARKER")).toHaveCount(0);
  await reiko.goto("/latest");
  await expect(reiko.getByRole("link", { name: SPAM_TITLE })).toHaveCount(0);
  // The affected member sees the content with the "非表示" marker.
  await sam.goto(spamPath);
  await expect(sam.getByRole("heading", { level: 1, name: SPAM_TITLE })).toBeVisible();
  await expect(sam.getByRole("note")).toContainText(enMessages.entry_hidden_mark);
  // The Markdown twin also contains only a placeholder.
  const md = await reiko.request.get(`${spamPath}.md`);
  expect(md.status()).toBe(200);
  const text = await md.text();
  expect(text).toContain("hidden: true");
  expect(text).not.toContain("SPAM-BODY-MARKER");
});

test("the public moderation log shows what was done, without who acted, who reported, the note or the post", async () => {
  await reiko.goto("/moderation");
  const row = reiko.locator("tbody tr").first();
  await expect(row.getByRole("cell").nth(1)).toHaveText(enMessages.log_action_hide);
  await expect(row.getByRole("cell").nth(2)).toHaveText(enMessages.reason_spam);
  await expect(row.getByRole("cell").nth(3)).toHaveText("日本語");
  const body = await reiko.locator("main").innerText();
  for (const secret of ["olga", "sam", "reiko", "advertisement", "SPAM", "安い"]) expect(body, secret).not.toContain(secret);
  await expect(reiko.locator("main a")).toHaveCount(0);
});

test("the author is notified of the decision with the explanation and appeals; the operator who decided does not review it", async () => {
  await sam.goto("/notifications");
  const item = sam.locator("li", { hasText: enMessages.notification_moderation_hide });
  await expect(item).toBeVisible();
  await expect(item).toContainText(formatMessage(enMessages.notification_reason, { reason: enMessages.reason_spam }));
  await expect(item).toContainText(formatMessage(enMessages.notification_note, { note: "advertisement, removed under the no-spam rule" }));
  await item.getByRole("link").filter({ hasText: enMessages.notification_moderation_hide }).click();
  await expect(sam).toHaveURL(new RegExp(`${spamPath}$`));
  await expect(sam.getByRole("note")).toContainText(formatMessage(enMessages.notification_reason, { reason: enMessages.reason_spam }));
  await sam.getByRole("note").getByRole("link", { name: enMessages.notification_appeal, exact: true }).click();
  await expect(sam.getByRole("heading", { name: enMessages.appeal_title })).toBeVisible();
  await expect(sam.getByRole("link", { name: enMessages.card_open, exact: true })).toHaveAttribute("href", spamPath);
  await sam.getByLabel(enMessages.appeal_text).fill("It was a product review, not an advertisement.");
  await sam.getByRole("button", { name: enMessages.appeal_submit }).click();
  await expect(sam.getByText(enMessages.appeal_sent)).toBeVisible();
  await expect(sam.getByText(enMessages.appeal_status_open)).toBeVisible();
  // The operator who took the action does not see this appeal.
  await olga.goto("/mod/appeals");
  await expect(olga.getByText(enMessages.mod_appeals_empty)).toBeVisible();
});

test("a reply notifies the topic author: the header count, the list, and marking it as read", async () => {
  // Opening the earlier action notification already cleared its unread state.
  await sam.goto("/notifications");
  await expect(sam.getByRole("img", { name: messagePattern(enMessages.nav_notifications_unread, { count: /\d+/ }) })).toHaveCount(0);
  friendlyPath = await postTopic(sam, FRIENDLY_TITLE, "気軽に話しましょう。");
  const before = logSize();
  await reiko.goto(friendlyPath);
  await reiko.getByLabel(enMessages.field_body).fill("ありがとうございます。REPLY-ONE");
  await reiko.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(reiko).toHaveURL(/#c-\d+$/);
  await sam.goto("/latest");
  await expect(sam.getByRole("img", { name: formatMessage(enMessages.nav_notifications_unread, { count: "1" }) })).toBeVisible();
  await sam.getByRole("link", { name: enMessages.nav_notifications }).click();
  const item = sam.locator("li", { hasText: formatMessage(enMessages.notification_reply_to_topic, { handle: "reiko", title: FRIENDLY_TITLE }) });
  await expect(item).toBeVisible();
  await item.getByRole("link", { name: formatMessage(enMessages.notification_reply_to_topic, { handle: "reiko", title: FRIENDLY_TITLE }), exact: true }).click();
  await expect(sam).toHaveURL(new RegExp(`${friendlyPath}#c-\\d+$`));
  await sam.goto("/notifications");
  await expect(sam.getByRole("img", { name: messagePattern(enMessages.nav_notifications_unread, { count: /\d+/ }) })).toHaveCount(0);
  await expect(item.locator('form input[name="intent"][value="read"]')).toHaveCount(0);
  // The default of the email setting is "Automatic": a reply is mailed soon (after the short delay of the test server)
  await mailFor("sam@example.com", before, messagePattern(enMessages.mail_subject_reply_to_topic, { handle: /.+/ }));
  // No notification for one's own reply.
  await sam.goto(friendlyPath);
  await sam.getByLabel(enMessages.field_body).fill("こちらこそ。");
  await sam.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(sam).toHaveURL(/#c-\d+$/);
  await sam.goto("/latest");
  await expect(sam.getByRole("img", { name: messagePattern(enMessages.nav_notifications_unread, { count: /\d+/ }) })).toHaveCount(0);
});

test("with the immediate email preference a reply is mailed in the member's language with an excerpt and a link without a token", async () => {
  await sam.goto("/settings");
  const form = sam.locator("form", { has: sam.getByRole("radio", { name: enMessages.settings_email_immediate, exact: true }) });
  await form.getByRole("radio", { name: enMessages.settings_email_immediate, exact: true }).check();
  await expect(form.getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(sam.getByText(enMessages.settings_saved, { exact: true })).toBeVisible();
  const before = logSize();
  await reiko.goto(friendlyPath);
  await reiko.getByLabel(enMessages.field_body).fill("二つ目の返信です。REPLY-TWO");
  await reiko.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(reiko).toHaveURL(/#c-\d+$/);
  const replyAnchor = new URL(reiko.url()).hash;
  const mail = await mailFor("sam@example.com", before, messagePattern(enMessages.mail_subject_reply_to_topic, { handle: /.+/ }));
  expect(mail.subject).toBe(formatMessage(enMessages.mail_subject_reply_to_topic, { handle: "reiko" }));
  // Mail uses the stored interface language; the fake English translation is prefixed.
  expect(mail.text).toMatch(messagePattern(enMessages.mail_item_reply_to_topic, { handle: "reiko", title: `[en] ${FRIENDLY_TITLE}`, excerpt: /[\s\S]*/, url: /https?:\/\/\S+/ }));
  expect(mail.text).toContain("二つ目の返信です。REPLY-TWO");
  expect(mail.text).toContain(`${state().baseURL}${friendlyPath}${replyAnchor}`);
  expect(mail.text).not.toMatch(/[?&]k=|token/i);
  expect(mail.text).toContain(`${state().baseURL}/settings`);
});

test("a member saves the daily preference and a reply still arrives on the site", async () => {
  await sam.goto("/settings");
  const form = sam.locator("form", { has: sam.getByRole("radio", { name: enMessages.settings_email_daily, exact: true }) });
  await form.getByRole("radio", { name: enMessages.settings_email_daily, exact: true }).check();
  await expect(form.getByRole("status")).toHaveText(enMessages.settings_saved);
  await expect(sam.getByText(enMessages.settings_saved, { exact: true })).toBeVisible();
  await sam.reload();
  await expect(sam.getByRole("radio", { name: enMessages.settings_email_daily, exact: true })).toBeChecked();
  await reiko.goto(friendlyPath);
  await reiko.getByLabel(enMessages.field_body).fill("三つ目の返信です。REPLY-THREE");
  await reiko.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(reiko).toHaveURL(/#c-\d+$/);

});


test("lower reply report feedback stays beside its controls with JavaScript", async ({ browser }) => {
  await sam.goto("/");
  const path = await postTopic(sam, "Reply report feedback", "A topic with a lower reply.");
  await sam.goto(path);
  await sam.getByLabel(enMessages.field_body).fill("First reportable reply");
  await sam.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(sam).toHaveURL(/#c-\d+$/);
  const replyId = new URL(sam.url()).hash.slice(3);
  const context = await browser.newContext({ storageState: await reikoContext.storageState(), extraHTTPHeaders: clientHeaders("10.4.0.4") });
  try {
    const page = await context.newPage();
    await page.goto(path);
    const article = page.locator(`#c-${replyId}`);
    await article.locator("summary").filter({ hasText: enMessages.flag_summary }).click();
    await article.getByRole("button", { name: enMessages.flag_submit }).click();
    await expect(article.getByRole("status")).toHaveText(enMessages.flag_thanks);
    await expect(page).toHaveURL(new RegExp(`#c-${replyId}$`));
    await expect(page.locator(`article#p-${path.split("/").at(-1)}`).getByRole("status").filter({ hasText: enMessages.flag_thanks })).toHaveCount(0);
    await page.reload();
    await expect(article.getByText(enMessages.flag_already_reported, { exact: true })).toBeVisible();
    await expect(article.getByRole("button", { name: enMessages.flag_submit })).toHaveCount(0);
  } finally { await context.close(); }
});
