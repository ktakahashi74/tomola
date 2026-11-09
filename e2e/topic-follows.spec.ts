import { captureListRows } from "./support/list-rows-evidence";
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages, formatMessage, followedThreadPattern, messagePattern, clientHeaders, logSize, mailFor, messageTitleField as titleField, waitForFormReady, openPlaces, closePlaces } from "./helpers";

// Following a topic, through the browser: the automatic follow of the author and of a replier, the follow button on the thread page, the merged
// "new replies in a topic you follow" notification, the default `auto` email (a reply is mailed at once, a followed-topic notification only in the daily digest),
// opening the topic marks the notification read, /following and its Markdown twin, and "Unfollow" that keeps its place. fiona signs up with the seeded invitation
// and invites gus. The tests share one server and one database and use the result of the one before, so they run in order.
test.describe.configure({ mode: "serial" });

const TITLE = "Follow me, please";
const FOLLOWED_TEXT = (count: number) => formatMessage(enMessages.notification_followed_thread, { title: TITLE, count, handle: "fiona" });
let fionaContext: BrowserContext;
let gusContext: BrowserContext;
let fiona: Page;
let gus: Page;
let topicPath: string;

test.beforeAll(async ({ browser }) => {
  fionaContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.8.0.1") });
  gusContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.8.0.2") });
  fiona = await fionaContext.newPage();
  gus = await gusContext.newPage();
});
test.afterAll(async () => {
  await fionaContext.close();
  await gusContext.close();
});

async function invite(page: Page, email: string): Promise<string> {
  await page.goto("/invites/new");
  await page.getByLabel(enMessages.invites_email).fill(email);
  await page.getByRole("button", { name: enMessages.invites_submit }).click();
  return await page.locator("code").innerText();
}

async function reply(page: Page, body: string) {
  await page.goto(topicPath);
  await page.getByLabel(enMessages.field_body).fill(body);
  await page.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(page.getByText(body)).toBeVisible();
}

// Click a follow or unfollow button and wait until the server has answered POST /follow (React Router sends a fetcher's request to /follow.data): the button changes at once (it shows what is being sent), so a reload right after the click
// could cancel the request.
async function clickAndWaitForFollow(page: Page, button: Locator) {
  await Promise.all([page.waitForResponse((res) => /^\/follow(\.data)?$/.test(new URL(res.url()).pathname) && res.request().method() === "POST"), button.click()]);
}

const followedItems = (page: Page) => page.locator("li", { hasText: followedThreadPattern() });

test("a member who starts a topic follows it; the header has the Following link and the email setting defaults to automatic", async () => {
  await useMember(fiona, "fiona@example.com");
  await expect((await openPlaces(fiona)).locator('a[href="/following"]')).toContainText(enMessages.nav_following);
  await closePlaces(fiona);
  await fiona.getByRole("link", { name: enMessages.nav_new_topic }).click();
  await waitForFormReady(fiona.locator("form", { has: titleField(fiona) }));
  await titleField(fiona).fill(TITLE);
  await fiona.getByLabel(enMessages.field_body).fill("A topic to follow.");
  await fiona.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(fiona.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  topicPath = new URL(fiona.url()).pathname;
  // Followed at once (the author), with the button pressed
  await expect(fiona.getByRole("button", { name: enMessages.follow_unfollow, exact: true })).toBeVisible();
  // The default of the email setting is "Automatic"
  await fiona.goto("/settings");
  await expect(fiona.getByRole("radio", { name: enMessages.settings_email_auto })).toBeChecked();
  await expect(fiona.getByRole("radio", { name: enMessages.settings_email_immediate })).not.toBeChecked();
});

test("a replier follows the topic automatically; the author is told of the reply, and mailed at once (auto: a reply is sent soon)", async () => {
  const since = logSize();
  await useMember(gus, "gus@example.com");
  await gus.goto(topicPath);
  // Not followed before replying
  await expect(gus.getByRole("button", { name: enMessages.follow_button, exact: true })).toBeVisible();
  await gus.clock.install();
  await reply(gus, "Gus replies once.");
  await expect(gus.getByRole("button", { name: enMessages.follow_unfollow, exact: true })).toBeVisible();
  await expect(gus.getByText(enMessages.posted_reply_followed, { exact: true })).toBeVisible();
  const noticeURL = new URL(gus.url());
  expect(noticeURL.searchParams.get("posted")).toMatch(/^\d+$/);
  expect(noticeURL.searchParams.get("followed")).toBe("1");
  // The shared cleanup also removes edit markers and preserves the reply anchor.
  noticeURL.searchParams.set("edited", noticeURL.searchParams.get("posted")!);
  await gus.evaluate(url => history.replaceState(history.state, "", url), noticeURL.href);
  await gus.clock.fastForward(6000);
  await expect(gus).toHaveURL(new URL(`${topicPath}${noticeURL.hash}`, gus.url()).href);
  await fiona.goto("/notifications");
  await expect(fiona.getByText(formatMessage(enMessages.notification_reply_to_topic, { handle: "gus", title: TITLE }))).toBeVisible();
  const mail = await mailFor("fiona@example.com", since, messagePattern(enMessages.mail_subject_reply_to_topic, { handle: "gus" }));
  expect(mail.text).toContain("Gus replies once.");
});

test("the thread page button follows and unfollows, and the state is the server's (it survives a reload)", async () => {
  await gus.goto(topicPath);
  await clickAndWaitForFollow(gus, gus.getByRole("button", { name: enMessages.follow_unfollow, exact: true }));
  await expect(gus.getByRole("button", { name: enMessages.follow_button, exact: true })).toBeVisible();
  await gus.reload();
  await expect(gus.getByRole("button", { name: enMessages.follow_button, exact: true })).toBeVisible();
  await clickAndWaitForFollow(gus, gus.getByRole("button", { name: enMessages.follow_button, exact: true }));
  await expect(gus.getByRole("button", { name: enMessages.follow_unfollow, exact: true })).toBeVisible();
  await gus.reload();
  await expect(gus.getByRole("button", { name: enMessages.follow_unfollow, exact: true })).toBeVisible();
});

test("new replies in a followed topic are one notification while unread, with the count and the latest", async () => {
  const since = logSize();
  await reply(fiona, "Fiona answers the first time.");
  await gus.goto("/notifications");
  await expect(followedItems(gus)).toHaveCount(1);
  await expect(followedItems(gus).first()).toContainText(FOLLOWED_TEXT(1));
  // A new reply in a followed post is not addressed to the member: the bell has no number; the Following place has a dot.
  await expect(gus.getByRole("img", { name: messagePattern(enMessages.nav_notifications_unread, { count: /\d+/ }) })).toHaveCount(0);
  await expect((await openPlaces(gus)).locator('a[href="/following"] .bg-unread')).toHaveCount(1);
  await closePlaces(gus);
  // The second reply merges into the same notification
  await reply(fiona, "Fiona answers the second time.");
  await gus.goto("/notifications");
  await expect(followedItems(gus)).toHaveCount(1);
  await expect(followedItems(gus).first()).toContainText(FOLLOWED_TEXT(2));
  // The link goes to the latest reply
  await followedItems(gus).first().getByRole("link", { name: FOLLOWED_TEXT(2), exact: true }).click();
  await expect(gus).toHaveURL(/\/t\/\d+#c-\d+$/);

});

test("opening the topic marks its followed_thread notification as read, and the next reply starts a new one", async () => {
  await gus.goto(topicPath);
  await gus.goto("/notifications");
  await expect(followedItems(gus)).toHaveCount(1);
  await expect(followedItems(gus).first().locator('input[name="intent"][value="read"]')).toHaveCount(0);
  await expect(gus.getByRole("img", { name: messagePattern(enMessages.nav_notifications_unread, { count: /\d+/ }) })).toHaveCount(0);
  await reply(fiona, "Fiona answers the third time.");
  await gus.goto("/notifications");
  await expect(followedItems(gus)).toHaveCount(2);
  await expect(followedItems(gus).first()).toContainText(FOLLOWED_TEXT(1));
});

test("/following has unread reply links and unfollowing on the topic removes its row", async () => {
  await (await openPlaces(gus)).locator('a[href="/following"]').click();
  await expect(gus).toHaveURL(/\/following$/);
  await expect(gus.getByRole("heading", { level: 1, name: enMessages.following_title })).toBeVisible();
  // The rule is behind a fold that names it.
  await expect(gus.getByText(enMessages.following_rule)).not.toBeVisible();
  await gus.getByText(enMessages.following_auto_label, { exact: true }).click();
  await expect(gus.getByText(enMessages.following_rule)).toBeVisible();
  const item = gus.locator("li", { hasText: TITLE });
  await expect(item).toHaveCount(1);
  const unread = item.getByRole("link", { name: formatMessage(enMessages.following_new_replies, { count: 1 }), exact: true });
  await expect(unread).toHaveAttribute("href", new RegExp(`^${topicPath}#c-`));
  await expect(item.getByRole("link", { name: formatMessage(enMessages.home_replies, { count: 4 }), exact: true })).toBeVisible();
  await captureListRows(gus, "following-unread");
  await expect(item.getByRole("button", { name: enMessages.follow_unfollow })).toHaveCount(0);
  await gus.goto(topicPath);
  await clickAndWaitForFollow(gus, gus.getByRole("button", { name: enMessages.follow_unfollow, exact: true }));
  await expect(gus.getByRole("button", { name: enMessages.follow_button, exact: true })).toBeVisible();
  await gus.goto("/following");
  await gus.reload();
  await expect(gus.locator("li", { hasText: TITLE })).toHaveCount(0);
  await expect(gus.getByText(enMessages.following_empty)).toBeVisible();
  // An unfollowed topic makes no new notification (the unread one from before stays at 1, and no row is added), and the number of followers is shown nowhere
  await reply(fiona, "Fiona answers the fourth time.");
  await gus.goto("/notifications");
  await expect(followedItems(gus)).toHaveCount(2);
  await expect(followedItems(gus).first()).toContainText(FOLLOWED_TEXT(1));
  await gus.goto(topicPath);
  await expect(gus.getByText(/follower/i)).toHaveCount(0);
});

test("/following.md serves the member's followed topic without caching", async ({ request }) => {
  const mine = await fionaContext.request.get("/following.md?all=1");
  expect(mine.status()).toBe(200);
  expect(mine.headers()["cache-control"]).toBe("private, no-store");
  expect(await mine.text()).toContain("id: p-" + topicPath.split("/").pop());

});
