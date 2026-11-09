import { routeModule } from "./support/module-route";
import fs from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, state, enMessages as m, waitForClientRoute, waitForHydration, waitForFormReady } from "./helpers";
import { saveEditorDraft } from "./draft-autosave-helper";

const body = (page: Page) => page.locator('textarea[name="body"]');
async function publish(page: Page, text: string) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill(text);
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  return new URL(page.url()).pathname;
}

test("a failed image module leaves the written post usable", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const moduleRoute = await routeModule(page, "app/components/media-upload-client.tsx", async route => { await held; await route.abort(); });
  try {
    await useMember(page, "safety_media@example.com", "/t/new");
    await moduleRoute.assertHit();
    await body(page).fill("Text survives a missing image module.");
    release();
    await expect(page.getByText(m.media_unavailable)).toBeVisible();
    await expect(body(page)).toHaveValue("Text survives a missing image module.");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+/);
  } finally { release(); await context.close(); }
});

test("unsent text guards both document reloads and client navigation, but not saving", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await useMember(page, "safety_guard@example.com", "/t/new");
    await waitForHydration(page);
    await page.route("**/drafts/autosave", route => route.abort());
    await body(page).fill("Keep this unsent text.");
    let dialogs = 0;
    page.on("dialog", async dialog => { dialogs++; await dialog.dismiss(); });
    await page.evaluate(() => window.location.reload());
    await expect.poll(() => dialogs).toBe(1);
    await expect(body(page)).toHaveValue("Keep this unsent text.");
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("#compose"));
    await waitForClientRoute(page);
    expect(dialogs).toBe(1);
    // A move to a different page uses the client router.
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
    await expect.poll(() => dialogs).toBe(2);
    await expect(page).toHaveURL(/\/t\/new(?:#compose)?$/);
    await expect(body(page)).toHaveValue("Keep this unsent text.");
    await page.unroute("**/drafts/autosave");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await saveEditorDraft(page);
    await expect(page).toHaveURL(/\/drafts\/\d+/);
    await waitForClientRoute(page);
    expect(dialogs).toBe(2);
    const draftPath = new URL(page.url()).pathname;
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
    await expect(page).toHaveURL(/\/latest$/);
    expect(dialogs).toBe(2);
    await page.goto(draftPath);
    await waitForHydration(page);
    await page.route("**/drafts/autosave", route => route.abort());
    await body(page).fill("Saved draft, changed text.");
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
    await expect.poll(() => dialogs).toBe(3);
    await expect(body(page)).toHaveValue("Saved draft, changed text.");
    await page.unroute("**/drafts/autosave");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await saveEditorDraft(page);
    await expect(page.getByText(m.draft_autosave_saved, { exact: true })).toBeVisible();
    await waitForClientRoute(page);
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
    await expect(page).toHaveURL(/\/latest$/);
    expect(dialogs).toBe(3);
    await page.goto(draftPath);
    await waitForHydration(page);
    await body(page).fill("The snapshot being saved.");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/drafts/autosave", async route => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    try {
      const sending = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave");
      await sending;
      expect(dialogs).toBe(3);
      await body(page).fill("Additional input while saving.");
      await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
      await expect.poll(() => dialogs).toBe(4);
      await page.route("**/drafts/autosave", route => route.abort());
      release();
      await waitForClientRoute(page);
      await expect(body(page)).toHaveValue("Additional input while saving.");
      await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
      await expect.poll(() => dialogs).toBe(5);
    } finally { release(); }
  } finally { await context.close(); }
});

test("another member's reply and an Insightful refresh preserve text; own publication clears it", async ({ browser }) => {
  const authorContext = await browser.newContext();
  const readerContext = await browser.newContext();
  const author = await authorContext.newPage();
  const reader = await readerContext.newPage();
  try {
    await useMember(author, "safety_author@example.com");
    const path = await publish(author, "---\ntitle: Input preservation question\nasks_stance: true\nlang: en\n---\nInput preservation topic.");
    await useMember(reader, "safety_reader@example.com", path);
    await waitForFormReady(reader.locator("#reply form"));
    await waitForFormReady(author.locator("#reply form"));
    await body(reader).fill("Unsent reader reply.");
    await body(author).fill("A reply arriving from another member.");
    await author.getByRole("button", { name: m.submit_reply, exact: true }).click();
    await expect(author.getByText("A reply arriving from another member.", { exact: true })).toBeVisible();
    await reader.getByRole("button", { name: m.insightful_give, exact: true }).first().click();
    await waitForClientRoute(reader);
    // Explicit refresh also covers pages which intentionally skip vote revalidation.
    await reader.evaluate(() => (window as unknown as { __reactRouterDataRouter: { revalidate(): void } }).__reactRouterDataRouter.revalidate());
    await expect(reader.getByText("A reply arriving from another member.", { exact: true })).toBeVisible();
    await expect(body(reader)).toHaveValue("Unsent reader reply.");
    const stance = reader.getByRole("group", { name: m.stance_title, exact: true });
    const agree = stance.getByRole("button", { name: m.stance_agree, exact: true });
    await agree.click();
    await expect(agree).toHaveAttribute("aria-pressed", "true");
    await expect(agree).toBeFocused();
    await reader.getByRole("button", { name: m.stance_withdraw, exact: true }).click();
    await expect(stance).toBeFocused();
    await expect(body(reader)).toHaveValue("Unsent reader reply.");
    await reader.getByRole("button", { name: m.submit_reply, exact: true }).click();
    await expect(reader.getByText("Unsent reader reply.", { exact: true })).toBeVisible();
    await expect(body(reader)).toHaveValue("");
    const clock = join(state().dir, "server-clock.txt");
    const previous = fs.readFileSync(clock, "utf8");
    // The allowance resets on the hour. Keep exhaustion and the browser's next
    // request in one window, even when the real clock is about to roll over.
    const now = Date.now() + Number(previous);
    fs.writeFileSync(clock, String(Number(previous) + 30 * 60_000 - now % 3_600_000));
    try {
      let limited = false;
      for (let attempt = 0; attempt < 31; attempt++) {
        const response = await reader.request.post("/vote", { form: { entryId: path.split("/").at(-1)!, on: "1" }, headers: { Origin: new URL(reader.url()).origin } });
        if (response.status() === 429) { limited = true; break; }
        expect(response.status()).toBe(200);
      }
      expect(limited).toBe(true);
      const refused = reader.waitForResponse(response => response.request().method() === "POST" && /^\/vote(?:\.data)?$/.test(new URL(response.url()).pathname));
      await reader.getByRole("button", { name: m.insightful_give, exact: true }).first().click();
      expect((await refused).status()).toBe(429);
      await expect(reader.getByText(m.error_rate_limited, { exact: true })).toBeVisible();
      await expect(reader.getByRole("heading", { name: "Input preservation question", exact: true })).toBeVisible();
    } finally { fs.writeFileSync(clock, previous); }
  } finally { await authorContext.close(); await readerContext.close(); }
});

test("edit navigation, cancel included, asks before discarding text, while save proceeds directly", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await useMember(page, "safety_edit@example.com");
    const path = await publish(page, "An editable post.");
    await page.goto(`${path}/edit`);
    await body(page).fill("Cancelled edit.");
    // Cancel asks first when text was changed (it would be lost): dismissing stays on the edit, accepting leaves it.
    let dialogs = 0;
    let accept = false;
    page.on("dialog", async dialog => { dialogs++; if (accept) await dialog.accept(); else await dialog.dismiss(); });
    await page.getByRole("link", { name: m.cancel, exact: true }).click();
    await expect.poll(() => dialogs).toBe(1);
    await expect(body(page)).toHaveValue("Cancelled edit.");
    accept = true;
    await page.getByRole("link", { name: m.cancel, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}(?:\\?.*)?$`));
    await waitForClientRoute(page);
    expect(dialogs).toBe(2);
    accept = false;
    dialogs = 0;
    await page.goto(`${path}/edit`);
    await body(page).fill("A saved edit.");
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/latest"));
    await expect.poll(() => dialogs).toBe(1);
    await expect(body(page)).toHaveValue("A saved edit.");
    await page.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}(?:\\?.*)?$`));
    expect(dialogs).toBe(1);
    await expect(page.getByRole("paragraph").filter({ hasText: /^A saved edit\.$/ })).toBeVisible();
  } finally { await context.close(); }
});
