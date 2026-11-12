import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { autosaveState } from "./autosave-clock";
import { enMessages as en, loginWithMagicLink, openUserMenu, useMember, waitForFormReady } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const records = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tomola:draft:")));
const logout = async (page: Page) => (await openUserMenu(page)).getByRole("menuitem", { name: en.nav_logout }).click();
async function open(page: Page, name: string) {
  await page.clock.install();
  await useMember(page, `departure_${name}@example.com`, "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
}
async function draft(page: Page) {
  await body(page).fill("The draft when opened.");
  await autosaveState(page, "saved");
  const id = Number(await page.locator('input[name="fromDraft"]').inputValue());
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
  return id;
}

test("logout preserves the latest saved server draft", async ({ page }) => {
  await open(page, "saved");
  const id = await draft(page);
  await body(page).fill("The latest saved writing.");
  await autosaveState(page, "saved");
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes.push(request.postData() ?? ""); });
  await logout(page);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await records(page)).toEqual([]);
  await page.goto("/login");
  await loginWithMagicLink(page, "departure_saved@example.com");
  await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
  await page.goto(`/drafts/${id}`);
  await expect(body(page)).toHaveValue("The latest saved writing.");
});

test("invalidated editors cannot flush reset text or block departure", async ({ page }) => {
  await open(page, "invalidated");
  const id = await draft(page);
  await body(page).fill("Saved before invalidation.");
  await autosaveState(page, "saved");
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes++; });
  const dirty = await page.evaluate(() => {
    localStorage.setItem("tomola:writing-generation", crypto.randomUUID());
    window.dispatchEvent(new Event("tomola:drafts-cleared"));
    const form = document.querySelector('form[data-autosave="ready"]')!;
    const detail: { dirty?: boolean } = {};
    form.dispatchEvent(new CustomEvent("tomola:autosave-dirty", { detail }));
    form.dispatchEvent(new CustomEvent("tomola:autosave-flush", { detail: { leaving: true } }));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    return detail.dirty;
  });
  await page.clock.fastForward(3000);
  await page.waitForTimeout(500);
  expect(writes).toBe(0);
  expect(dirty).toBe(false);
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Saved before invalidation.");
});

test("reply logout asks first, preserves cancellation, and clears only after success", async ({ page }) => {
  await open(page, "reply");
  await body(page).fill("A topic for the reply.");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  await waitForFormReady(page.locator("#reply form"));
  await body(page).fill("An unsent reply.");
  await page.clock.fastForward(3000);
  await expect.poll(() => records(page)).not.toEqual([]);
  const before = await records(page);
  let confirmations = 0;
  page.on("dialog", async dialog => { confirmations++; expect(dialog.message()).toBe(en.leave_unsaved_confirm); await dialog.dismiss(); });
  await logout(page);
  await expect.poll(() => confirmations).toBe(1);
  await expect(body(page)).toHaveValue("An unsent reply.");
  expect(await records(page)).toEqual(before);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(1);
  page.removeAllListeners("dialog");
  page.on("dialog", dialog => void dialog.accept());
  await logout(page);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(0);
  await expect.poll(() => records(page)).toEqual([]);
});

test("hidden large drafts avoid the keepalive limit and retry when visible", async ({ page }) => {
  await open(page, "large");
  await page.evaluate(() => {
    const original = window.fetch;
    const calls: { size: number; keepalive: boolean }[] = [];
    Object.assign(window, { departureCalls: calls });
    window.fetch = (input, init) => {
      if (String(input).includes("/drafts/autosave") && init?.method === "POST") {
        calls.push({ size: new TextEncoder().encode(String(init.body)).byteLength, keepalive: Boolean(init.keepalive) });
      }
      return original(input, init);
    };
  });
  await page.route("**/drafts/autosave", route => route.abort());
  await body(page).fill("日".repeat(10_000));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "failed");
  const calls = await page.evaluate(() => (window as unknown as { departureCalls: { size: number; keepalive: boolean }[] }).departureCalls);
  expect(calls[0].size).toBeGreaterThan(60 * 1024);
  expect(calls[0].keepalive).toBe(false);
  await page.unroute("**/drafts/autosave");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await autosaveState(page, "saved");
  await body(page).fill("A short departure save: 日");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await autosaveState(page, "saved");
  const short = await page.evaluate(() => (window as unknown as { departureCalls: { size: number; keepalive: boolean }[] }).departureCalls.at(-1)!);
  expect(short.size).toBeLessThanOrEqual(60 * 1024);
  expect(short.keepalive).toBe(true);
});

test("logout flushes pending draft edits before ending the session", async ({ page }) => {
  await open(page, "flush");
  const id = await draft(page);
  await body(page).fill("Saved by the logout departure flush.");
  await logout(page);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(0);
  await page.goto("/login");
  await loginWithMagicLink(page, "departure_flush@example.com");
  await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
  await page.goto(`/drafts/${id}`);
  await expect(body(page)).toHaveValue("Saved by the logout departure flush.");
});

test("a failed logout retains the local writing for recovery", async ({ page }) => {
  await open(page, "failed");
  await body(page).fill("A topic before the failed logout.");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  const path = new URL(page.url()).pathname;
  await waitForFormReady(page.locator("#reply form"));
  await body(page).fill("Recover this reply after the logout error.");
  await page.clock.fastForward(3000);
  await expect.poll(() => records(page)).not.toEqual([]);
  const before = await records(page);
  page.on("dialog", dialog => void dialog.accept());
  await page.route(/\/logout(?:\.data)?(?:\?|$)/, route => route.fulfill({ status: 503, body: "Unavailable" }));
  await logout(page);
  await expect(page.locator('textarea[name="body"]')).toHaveCount(0);
  expect(await records(page)).toEqual(before);
  await page.unroute(/\/logout(?:\.data)?(?:\?|$)/);
  await page.goto(path);
  await expect(body(page)).toHaveValue("Recover this reply after the logout error.");
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(1);
});

for (const reason of ["submit", "delete"] as const) {
  test(`paused ${reason} keeps device writing and departure checks without autosaving`, async ({ page }) => {
    await open(page, reason);
    await body(page).fill("Writing before the pause.");
    await autosaveState(page, "saved");
    const result = await page.evaluate(reason => {
      const form = document.querySelector<HTMLFormElement>('form[data-autosave="ready"]')!;
      if (reason === "delete") window.dispatchEvent(new Event("tomola:discard-unsaved"));
      else {
        // Run the capture listener without sending the publishing request.
        form.addEventListener("submit", event => event.preventDefault(), { once: true });
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      }
      const input = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
      input.value = "Writing while the request is pending.";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const detail: { dirty?: boolean } = {};
      form.dispatchEvent(new CustomEvent("tomola:autosave-dirty", { detail }));
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      return { dirty: detail.dirty, prevented: unload.defaultPrevented };
    }, reason);
    expect(result.dirty).toBe(true);
    if (reason === "submit") expect(result.prevented).toBe(true);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tomola:draft:")).map(key => JSON.parse(localStorage.getItem(key)!).body))).toContain("Writing while the request is pending.");
    let writes = 0;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes++; });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("online"));
    });
    await page.clock.fastForward(3000);
    await page.waitForTimeout(500);
    expect(writes).toBe(0);
  });
}

test("visible saved writing does not schedule another acknowledgement", async ({ page }) => {
  await open(page, "visible");
  await body(page).fill("Already saved writing.");
  await autosaveState(page, "saved");
  await page.evaluate(() => {
    Object.assign(window, { departureAcknowledgements: 0 });
    document.querySelector('form[data-autosave="ready"]')!.addEventListener("tomola:form-saved", () => {
      const target = window as unknown as { departureAcknowledgements: number };
      target.departureAcknowledgements++;
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(3000);
  expect(await page.evaluate(() => (window as unknown as { departureAcknowledgements: number }).departureAcknowledgements)).toBe(0);
});
