import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot, enMessages as m, state, useMember, waitForClientRoute } from "./helpers";
import { LANG_LABELS } from "../app/lib/languages";

async function screenshots(page: Page, name: string) {
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { path: `${name}-${width}.png`, fullPage: true }, "invitation-note");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}

test("an invitation note waits as plain text, then shows a marked translation and its original", async ({ page, browser }) => {
  const note = "この論考について、あなたの視点から応えてほしい。 https://example.com/essay";
  const held = path.join(state().dir, "fake-invitation-note-hold");
  const context = await browser.newContext({ baseURL: state().baseURL, locale: "en-US" });
  try {
    await useMember(page, "invite_note_translated@example.com", "/invites/new");
    await waitForClientRoute(page);
    await page.getByLabel(m.invites_email, { exact: true }).fill("invite_note_translated_recipient@example.com");
    await page.getByLabel(m.invites_note, { exact: true }).fill(note);
    await screenshots(page, "compose");
    await page.getByRole("button", { name: m.invites_submit, exact: true }).click();
    const link = page.locator("code").filter({ hasText: "/invite/" });
    await expect(link).toBeVisible();
    const url = (await link.textContent())!;
    fs.writeFileSync(held, note);
    const guest = await context.newPage();
    await guest.goto(url); await waitForClientRoute(guest);
    const content = guest.locator("[data-invitation-note]");
    await expect(content.getByText(note, { exact: true })).toBeVisible();
    await expect(content.locator("a")).toHaveCount(0);
    await expect(guest.getByRole("heading", { level: 1 })).toContainText("invite_note_translated");
    await screenshots(guest, "pending");
    fs.rmSync(held, { force: true });
    await expect(content.getByText(`[en] ${note}`, { exact: true })).toBeVisible({ timeout: 45000 });
    await expect(content.getByText(m.label_from_lang_machine.replace("{lang}", m.language_name_ja))).toBeVisible();
    await expect(content.locator('a[href^="https:"]')).toHaveCount(0);
    await screenshots(guest, "translated");
    await content.getByRole("link", { name: m.show_original, exact: true }).click();
    await expect(content.getByText(note, { exact: true })).toBeVisible();
    await content.getByRole("link", { name: m.show_translation, exact: true }).click();
    await expect(content.getByText(`[en] ${note}`, { exact: true })).toBeVisible();
    await guest.getByRole("combobox", { name: m.language_select, exact: true }).click();
    await guest.getByRole("option", { name: LANG_LABELS.ja, exact: true }).click();
    await expect(guest.locator("html")).toHaveAttribute("lang", "ja");
    await expect(content.getByText(note, { exact: true })).toBeVisible();
    await expect(content.locator("a")).toHaveCount(0);
    await page.reload();
    const row = page.getByRole("listitem").filter({ hasText: "invite_note_translated_recipient@example.com" });
    await row.getByRole("button", { name: m.invites_revoke, exact: true }).click();
    await expect(row.getByRole("button", { name: m.invites_revoke, exact: true })).toHaveCount(0);
    await guest.reload();
    await expect(content).toHaveCount(0);
  } finally { fs.rmSync(held, { force: true }); await context.close(); }
});

test("a note-free invitation keeps its original entry screen", async ({ page, browser }) => {
  await useMember(page, "invite_note_plain@example.com", "/invites/new");
  await waitForClientRoute(page);
  await page.getByLabel(m.invites_email, { exact: true }).fill("invite_note_plain_recipient@example.com");
  await page.getByRole("button", { name: m.invites_submit, exact: true }).click();
  const link = page.locator("code").filter({ hasText: "/invite/" });
  await expect(link).toBeVisible();
  const context = await browser.newContext({ baseURL: state().baseURL, locale: "en-US" });
  try {
    const guest = await context.newPage();
    await guest.goto((await link.textContent())!);
    await expect(guest.locator("[data-invitation-note]")).toHaveCount(0);
    await expect(guest.getByRole("button", { name: m.invite_submit, exact: true })).toBeVisible();
    await screenshots(guest, "without-note");
  } finally { await context.close(); }
});

test("an invitation stops polling a translation that stays pending", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const note = "この招待の翻訳を待ちます。";
  const held = path.join(state().dir, "fake-invitation-note-hold");
  const context = await browser.newContext({ baseURL: state().baseURL, locale: "en-US" });
  try {
    await useMember(page, "invite_poll_timeout@example.com", "/invites/new");
    await waitForClientRoute(page);
    await page.getByLabel(m.invites_email, { exact: true }).fill("invite_poll_timeout_recipient@example.com");
    await page.getByLabel(m.invites_note, { exact: true }).fill(note);
    await page.getByRole("button", { name: m.invites_submit, exact: true }).click();
    const link = page.locator("code").filter({ hasText: "/invite/" });
    await expect(link).toBeVisible();
    fs.writeFileSync(held, note);
    const guest = await context.newPage();
    await guest.clock.install();
    let reads = 0;
    guest.on("request", request => { if (new URL(request.url()).pathname.endsWith(".data")) reads++; });
    await guest.goto((await link.textContent())!);
    await waitForClientRoute(guest);
    for (let i = 0; i < 25; i++) {
      await guest.clock.runFor(2000);
      await guest.waitForLoadState("networkidle");
    }
    expect(reads).toBeGreaterThan(0);
    const stopped = reads;
    for (let i = 0; i < 5; i++) {
      await guest.clock.runFor(2000);
      await guest.waitForLoadState("networkidle");
    }
    expect(reads).toBe(stopped);
    await expect(guest.locator("[data-invitation-note]").getByText(note, { exact: true })).toBeVisible();
    await guest.reload();
    const before = reads;
    await guest.clock.runFor(2000);
    await expect.poll(() => reads).toBeGreaterThan(before);
  } finally { fs.rmSync(held, { force: true }); await context.close(); }
});
