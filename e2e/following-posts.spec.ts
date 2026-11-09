import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages as m, messageTitleField, waitForFormReady, openPlaces, closePlaces, waitForClientRoute } from "./helpers";

test("followed posts default to new replies, offer all posts and become quiet after the post is opened", async ({ page, browser }) => {
  const writerContext = await browser.newContext({ locale: "en-US" });
  try {
    const writer = await writerContext.newPage();
    await useMember(writer, "followed_posts_writer@example.com");
    const posts: string[] = [];
    for (const title of ["Followed posts fresh fixture", "Followed posts quiet fixture"]) {
      await writer.goto("/t/new");
      await waitForFormReady(writer.locator("form", { has: messageTitleField(writer) }));
      await messageTitleField(writer).fill(title);
      await writer.getByLabel(m.field_body).fill("An independently owned followed-post fixture.");
      await writer.getByRole("button", { name: m.submit_post, exact: true }).click();
      await expect(writer.getByRole("heading", { level: 1, name: title })).toBeVisible();
      posts.push(new URL(writer.url()).pathname);
    }
    await useMember(page, "followed_posts_reader@example.com");
    for (const path of posts) {
      await page.goto(path);
      await Promise.all([
        page.waitForResponse(response => /^\/follow(?:\.data)?$/.test(new URL(response.url()).pathname) && response.request().method() === "POST"),
        page.getByRole("button", { name: m.follow_button, exact: true }).click(),
      ]);
      await expect(page.getByRole("button", { name: m.follow_unfollow, exact: true })).toBeVisible();
      await waitForClientRoute(page);
    }
    await writer.goto(posts[0]);
    await writer.getByLabel(m.field_body).fill("A reply for the unread list.");
    await writer.getByRole("button", { name: m.submit_reply, exact: true }).click();
    await expect(writer.getByText("A reply for the unread list.")).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/following?vpage=obsolete");
      await expect(page).toHaveTitle(m.following_title);
      await expect(page.locator(`main a[href="${posts[0]}"]`).first()).toBeVisible();
      await expect(page.locator(`main a[href="${posts[1]}"]`)).toHaveCount(0);
      await expect((await openPlaces(page)).locator('a[href="/following"] .bg-unread')).toHaveCount(1);
      await closePlaces(page);
      const filters = page.getByRole("navigation", { name: m.following_filter_label });
      await filters.getByRole("link", { name: m.following_filter_all, exact: true }).click();
      await expect(page).toHaveURL(/\/following\?all=1$/);
      await expect(page.locator(`main a[href="${posts[1]}"]`).first()).toBeVisible();
      await filters.getByRole("link", { name: m.following_filter_new, exact: true }).click();
      await expect(page.locator(`main a[href="${posts[1]}"]`)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const unreadMd = await page.request.get("/following.md");
    expect(await unreadMd.text()).toContain(`id: p-${posts[0].split("/").pop()}`);
    const allMd = await page.request.get("/following.md?all=1");
    expect(await allMd.text()).toContain(`id: p-${posts[1].split("/").pop()}`);
    await page.locator(`main a[href="${posts[0]}"]`).first().click();
    await page.goto("/following");
    await expect(page.getByText(m.following_no_new_replies, { exact: true })).toBeVisible();
    await expect((await openPlaces(page)).locator('a[href="/following"] .bg-unread')).toHaveCount(0);
    await closePlaces(page);
    await page.locator("main").getByRole("link", { name: m.following_filter_all, exact: true }).last().click();
    for (const path of posts) await expect(page.locator(`main a[href="${path}"]`).first()).toBeVisible();
    await page.goto("/following?asks=1&lang=en&page=2");
    await page.getByRole("navigation", { name: m.following_filter_label }).getByRole("link", { name: m.following_filter_all, exact: true }).click();
    await expect(page).toHaveURL(/\/following\?asks=1&lang=en&all=1$/);
  } finally { await writerContext.close(); }
});
