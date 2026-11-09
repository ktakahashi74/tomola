import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, enMessages as en, state, useMember, waitForClientRoute } from "./helpers";

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "reading-actions.json"), "utf8")) as Record<string, number>;
const css = fs.readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
const breakpointEm = Number(css.match(/@media \(min-width: ([\d.]+)em\) \{(?:(?!@media)[\s\S])*?body:has\(\.reading-toc-sidebar\)/)![1]);

async function middle(page: Page) {
  await page.locator("[data-reading-body]").evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2));
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}
async function photo(page: Page, name: string) {
  await captureScreenshot(page, { path: `${name}.png`, animations: "disabled" }, "implemented");
}
async function checkAiAndShare(page: Page, actions: Locator) {
  await actions.getByRole("button", { name: en.open_in_ai, exact: true }).click();
  const chooser = page.getByRole("dialog", { name: en.open_in_ai_dialog_title });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button", { name: en.cancel, exact: true }).click();
  await actions.getByRole("button", { name: en.open_in_ai_menu, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: en.open_in_ai_copy_md, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await actions.locator("details > summary").filter({ hasText: en.share_topic }).click();
  const share = page.locator("[data-topic-share]");
  await expect(share).toBeInViewport();
  await share.getByRole("button", { name: en.share_copy_link, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`${new URL(page.url()).pathname}?lang=en`, state().baseURL).href);
  await page.keyboard.press("Escape");
  await expect(share).toBeHidden();
  await noOverflow(page);
}

test("article actions remain reachable through reading, preserve navigation and arrange public endings", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const f = fixture();
  const publicMode = Boolean(test.info().project.metadata.publicReading);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const opened: string[] = [];
  await page.context().route("https://ai.example/**", route => {
    opened.push(new URL(route.request().url()).searchParams.get("prompt")!);
    return route.fulfill({ contentType: "text/html", body: "<title>Fixture AI</title>" });
  });
  const breakpoint = await page.evaluate(em => em * parseFloat(getComputedStyle(document.documentElement).fontSize), breakpointEm);
  const rail = page.locator(".reading-toc-sidebar [data-reading-actions]");
  const menu = page.locator(".reading-action-menu");
  const trigger = menu.locator(":scope > summary");
  for (const guest of publicMode ? [true, false] : [false]) {
    const mode = `${publicMode ? "public" : "private"}-${guest ? "guest" : "member"}`;
    if (!guest) await useMember(page, "reading_actions@example.com");
    for (const width of [1680, 1366, breakpoint, breakpoint - 1, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const kind of ["toc", "plain"]) {
        await page.goto(`/t/${f[kind]}?lang=en`);
        await waitForClientRoute(page);
        await expect(menu).toHaveCount(1);
        await expect(page.locator("article .reading-action-menu")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        if (width >= breakpoint) {
          await expect(rail).toBeVisible();
          await expect(trigger).toBeHidden();
          const bounds = await page.evaluate(() => {
            const text = document.querySelector("[data-reading-body]")!.getBoundingClientRect();
            const panel = document.querySelector(".reading-toc-sidebar")!.getBoundingClientRect();
            return { textEnd: text.right, panelStart: panel.left, panelEnd: panel.right, viewport: document.documentElement.clientWidth };
          });
          expect(bounds.panelStart).toBeGreaterThan(bounds.textEnd);
          expect(bounds.panelEnd).toBeLessThanOrEqual(bounds.viewport);
          await middle(page);
          await expect(rail.getByRole("button", { name: en.open_in_ai, exact: true })).toBeInViewport();
          await checkAiAndShare(page, rail);
          await expect(rail.getByRole("link", { name: en.reply_write_title, exact: true })).toHaveCount(guest ? 0 : 1);
          await expect(rail.getByRole("button", { name: en.saved_add, exact: true })).toHaveCount(guest ? 0 : 1);
        } else {
          await expect(rail).toBeHidden();
          await middle(page);
          await expect(trigger).toBeInViewport();
          await expect(trigger).toHaveAccessibleName(en.reading_actions_label);
          const position = (await trigger.boundingBox())!;
          await trigger.focus();
          await page.keyboard.press("Enter");
          const actions = menu.locator("[data-reading-actions]");
          await expect(actions).toBeVisible();
          expect((await trigger.boundingBox())!.y).toBe(position.y);
          await page.keyboard.press("Tab");
          await expect(actions.getByRole("button", { name: en.open_in_ai, exact: true })).toBeFocused();
          await checkAiAndShare(page, actions);
          await expect(actions.getByRole("link", { name: en.reply_write_title, exact: true })).toHaveCount(guest ? 0 : 1);
          await expect(actions.getByRole("button", { name: en.saved_add, exact: true })).toHaveCount(guest ? 0 : 1);
        }
        await photo(page, `${mode}-${kind}-${width}-middle`);
        if (width < breakpoint) {
          await trigger.focus(); await page.keyboard.press("Escape");
          await expect(menu).not.toHaveAttribute("open", "");
        }
        const reply = page.locator("#reply");
        await expect(page.locator("[data-reply-heading]")).toHaveCount(guest ? 0 : 1);
        if (guest) {
          await expect(reply).toContainText(en.reading_end_intro);
          await expect(reply).toContainText(en.public_reading_reply);
          await expect(reply.getByRole("link", { name: en.login_title, exact: true })).toBeVisible();
          expect(await reply.evaluate(element => Boolean(document.getElementById("replies")!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
          await expect(page.locator("[data-article-end]")).not.toContainText(en.reading_end_intro);
          await expect(reply).toHaveCSS("border-top-width", kind === "toc" ? "1px" : "0px");
        } else await expect(reply.locator("textarea[name=body]")).toHaveCount(1);
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await photo(page, `${mode}-${kind}-${width}-end`);
        await noOverflow(page);
        if (width < breakpoint) {
          const last = page.locator("footer").last();
          const footer = (await last.boundingBox())!;
          const button = (await trigger.boundingBox())!;
          expect(footer.y + footer.height).toBeLessThanOrEqual(button.y);
        }
      }
    }
    // Fragment navigation creates a history entry for the reading position.
    for (const width of [1366, 390]) {
      if (guest) break;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/t/${f.toc}?lang=en`); await waitForClientRoute(page); await middle(page);
      const before = await page.evaluate(() => scrollY);
      if (width < breakpoint) await trigger.click();
      const actions = width >= breakpoint ? rail : menu;
      await actions.getByRole("link", { name: en.reply_write_title, exact: true }).click();
      await expect(page).toHaveURL(/#reply$/);
      await expect(page.locator("#reply")).toBeInViewport();
      await page.goBack();
      await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(before, -1);
      if (width < breakpoint) await trigger.click();
      await actions.getByRole("button", { name: en.saved_add, exact: true }).click();
      await expect(actions.getByRole("button", { name: en.saved_remove, exact: true })).toHaveAttribute("aria-pressed", "true");
      if (width < breakpoint && !(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await trigger.click();
      await actions.getByRole("button", { name: en.saved_remove, exact: true }).click();
      if (width < breakpoint && !(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await trigger.click();
      await expect(actions.getByRole("button", { name: en.saved_add, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
  }
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "custom", template: "https://ai.example/?prompt={prompt}" })));
  const resources: string[] = [];
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/t/${f.toc}?lang=en`); await waitForClientRoute(page);
    const entrances: Locator[] = [];
    if (width >= breakpoint) entrances.push(rail);
    else entrances.push(menu);
    for (const entrance of entrances) {
      if (entrance === menu) { await middle(page); await trigger.click(); }
      const before = opened.length;
      await entrance.getByRole("button", { name: en.open_in_ai, exact: true }).click();
      await expect.poll(() => opened.length).toBe(before + 1);
      const url = new URL(opened.at(-1)!.match(/https?:\/\/[^\s]+/)![0]);
      expect(url.pathname).toBe(`/t/${f.toc}.md`);
      url.searchParams.delete("k"); url.searchParams.delete("o");
      resources.push(url.href);
      await page.bringToFront();
    }
  }
  expect(new Set(resources).size).toBe(1);
  // The owner can read a hidden article, but cannot reply to it.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`/t/${f.hidden}?lang=en`); await waitForClientRoute(page);
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("link", { name: en.reply_write_title, exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 }); await trigger.click();
  await expect(menu.getByRole("link", { name: en.reply_write_title, exact: true })).toHaveCount(0);
  const native = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  try {
    const reader = await native.newPage();
    for (const width of [1366, 390]) {
      await reader.setViewportSize({ width, height: 900 }); await reader.goto(`/t/${f.plain}?lang=en`);
      await expect(reader.locator(".reading-action-menu")).toHaveCount(0);
      const sidebar = reader.locator(".reading-toc-sidebar");
      if (width >= breakpoint) {
        await expect(sidebar.getByRole("link", { name: en.open_in_ai_noscript, exact: true })).toHaveAttribute("href", `/t/${f.plain}.md?lang=en`);
        await expect(sidebar.getByRole("link", { name: en.reply_write_title, exact: true })).toHaveAttribute("href", `/t/${f.plain}?lang=en#reply`);
      }
    }
  } finally { await native.close(); }
  expect(errors).toEqual([]);
});

test("compact article actions return focus from portalled controls and close on keyboard exit", async ({ page }) => {
  test.setTimeout(120_000);
  const f = fixture();
  const publicMode = Boolean(test.info().project.metadata.publicReading);
  const menu = page.locator(".reading-action-menu");
  const trigger = menu.locator(":scope > summary");
  const actions = menu.locator("[data-reading-actions]");
  const ai = actions.getByRole("button", { name: en.open_in_ai, exact: true });
  const shareTrigger = actions.locator("details > summary");
  const share = page.locator("[data-topic-share]");
  const breakpoint = await page.evaluate(em => em * parseFloat(getComputedStyle(document.documentElement).fontSize), breakpointEm);
  for (const guest of publicMode ? [true, false] : [false]) {
    if (!guest) await useMember(page, "reading_actions@example.com");
    for (const width of [breakpoint - 1, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/t/${f.plain}?lang=en`);
      await waitForClientRoute(page);
      await middle(page);
      await expect(trigger).toHaveAttribute("aria-label", en.reading_actions_label);
      await trigger.focus();
      await page.keyboard.press("Space");
      await expect(ai).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(ai).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(menu).not.toHaveAttribute("open", "");
      await page.keyboard.press("Escape");
      await expect(trigger).not.toBeFocused();

      await trigger.click();
      const last = guest ? shareTrigger : actions.getByRole("link", { name: en.reply_write_title, exact: true });
      await last.focus();
      await page.keyboard.press("Tab");
      await expect(menu).not.toHaveAttribute("open", "");
      await expect(trigger).not.toBeFocused();

      for (const backwards of [true, false]) {
        await trigger.click();
        await shareTrigger.click();
        await expect(share.locator("select")).toBeFocused();
        if (!backwards) await share.locator("select, button, a[href]").last().focus();
        await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
        await expect(share).toBeHidden();
        await expect(shareTrigger).toBeFocused();
        await expect(menu).toHaveAttribute("open", "");
        await page.keyboard.press("Tab");
        if (guest) await expect(menu).not.toHaveAttribute("open", "");
        else {
          await expect(actions.getByRole("button", { name: en.saved_add, exact: true })).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();
          await expect(menu).not.toHaveAttribute("open", "");
        }
      }

      await trigger.click();
      await ai.click();
      const chooser = page.getByRole("dialog", { name: en.open_in_ai_dialog_title });
      await expect(chooser).toBeVisible();
      await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 8, y: 8 } });
      await expect(chooser).toBeHidden();
      await expect(menu).toHaveAttribute("open", "");
      await expect(ai).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(actions.getByRole("button", { name: en.open_in_ai_menu, exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).not.toHaveAttribute("open", "");
      await expect(trigger).toBeFocused();
    }
  }
});
