import { expect, type Page } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { clientHeaders, enMessages as en, messagePattern, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

// Small things the sweep of the screens found: who is told about a saved edit, who is told how to join, the handle suggestions of the visual editor, and the notice after a reply.
test.describe.configure({ mode: "serial" });

const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const mark = Math.random().toString(36).slice(2, 8);

async function writePost(page: Page, text: string) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }));
  await expect(rich(page)).toBeVisible();
  await rich(page).click();
  await page.keyboard.type(text);
}
async function submitPost(page: Page) {
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
  return Number(/\/t\/(\d+)/.exec(page.url())![1]);
}

let topicId: number;

test("a notice of a saved edit is told to the author of what was edited, and to no one else", async ({ browser }) => {
  const writerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.91.0.1") });
  const readerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.91.0.2") });
  const writer = await writerContext.newPage();
  const reader = await readerContext.newPage();
  try {
    await useMember(writer, "tidy_writer@example.com");
    await writePost(writer, `A post to be edited ${mark}`);
    topicId = await submitPost(writer);
    await writer.goto(`/t/${topicId}?edited=${topicId}`);
    await waitForClientRoute(writer);
    await expect(writer.getByText(en.edited_saved, { exact: true })).toBeVisible();
    // The same address, opened by someone who did not write the post, tells nothing.
    await useMember(reader, "tidy_reader@example.com", `/t/${topicId}?edited=${topicId}`);
    await waitForClientRoute(reader);
    await expect(reader.getByRole("paragraph").filter({ hasText: `A post to be edited ${mark}` })).toBeVisible();
    // The notice is a part loaded after the page; give it the time it would take.
    await reader.waitForLoadState("networkidle");
    await expect(reader.getByText(en.edited_saved, { exact: true })).toHaveCount(0);
  } finally { await writerContext.close(); await readerContext.close(); }
});

test("the end of a public document tells how to join only to someone who is not a member", async ({ browser, page }) => {
  const guestContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.91.0.3") });
  const guest = await guestContext.newPage();
  try {
    await guest.goto("/principles");
    await expect(guest.getByText(en.public_document_invitation, { exact: true })).toBeVisible();
    await useMember(page, "tidy_reader@example.com", "/principles");
    await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
    await expect(page.getByText(en.public_document_invitation, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: en.public_document_read_posts, exact: true })).toBeVisible();
  } finally { await guestContext.close(); }
});

test("the visual editor offers the members while a handle is typed, and the one chosen is told of the post", async ({ browser }) => {
  const writerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.91.0.4") });
  const targetContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.91.0.5") });
  const writer = await writerContext.newPage();
  const target = await targetContext.newPage();
  try {
    await useMember(writer, "tidy_writer@example.com");
    await writePost(writer, "Thank you @tidy_t");
    const list = writer.getByRole("listbox", { name: en.mention_suggestions_label });
    await expect(list).toBeVisible();
    await expect(list.getByRole("option", { name: "@tidy_target" })).toBeVisible();
    await writer.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await writer.keyboard.type(`for reading ${mark}`);
    const id = await submitPost(writer);
    await expect(writer.locator("article a.mention")).toHaveText(["@tidy_target"]);
    await useMember(target, "tidy_target@example.com", "/notifications");
    await waitForClientRoute(target);
    await expect(target.locator("li", { hasText: messagePattern(en.notification_mention, { handle: "tidy_writer", title: /.+/ }) }).first()).toBeVisible();
    expect(id).toBeGreaterThan(0);
  } finally { await writerContext.close(); await targetContext.close(); }
});
