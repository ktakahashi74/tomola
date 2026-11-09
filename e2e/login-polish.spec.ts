import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, waitForHydration, captureScreenshot, clientHeaders, enMessages as m, logSize, loginCodeFor, requestMagicLink, confirmMagicLink, signUp, state  } from "./helpers";

const loginResponse = (page: Page) => page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/login.data");
const loginPath = (next: string) => `/login?next=${encodeURIComponent(next)}`;
async function logOut(page: Page) {
  await page.request.post("/logout", { headers: { origin: state().baseURL }, form: {} });
}

test("return events coalesce and keep an unsigned-in email, partial code, and error", async ({ page }) => {
  await page.setExtraHTTPHeaders(clientHeaders("10.39.0.1"));
  await page.goto("/login");
  await waitForClientRoute(page);
  const email = page.getByLabel(m.login_email, { exact: true });
  await email.fill("unfinished");
  await page.locator("form", { has: email }).evaluate(form => { (form as HTMLFormElement).noValidate = true; });
  await page.getByRole("button", { name: m.login_submit, exact: true }).click();
  await expect(page.getByText(m.login_invalid_email, { exact: true })).toBeVisible();
  await email.fill("login_polish_unfinished@example.com");
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/login.data*", async route => { requests++; await gate; await route.continue(); });
  const refreshed = loginResponse(page);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect.poll(() => requests).toBe(1);
  release();
  await refreshed;
  await waitForClientRoute(page);
  expect(requests).toBe(1);
  await expect(email).toHaveValue("login_polish_unfinished@example.com");
  await expect(page.getByText(m.login_invalid_email, { exact: true })).toBeVisible();
  // A distinct quick return must be delayed, rather than lost to throttling.
  const quickReturn = loginResponse(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await quickReturn;
  expect(requests).toBe(2);
  await expect(email).toHaveValue("login_polish_unfinished@example.com");
  await expect(page.getByText(m.login_invalid_email, { exact: true })).toBeVisible();
  await page.unroute("**/login.data*");
  await page.getByRole("button", { name: m.login_submit, exact: true }).click();
  const code = page.getByLabel(m.login_code_label, { exact: true });
  await code.fill("000000");
  await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
  await expect(page.getByText(m.login_code_invalid, { exact: true })).toBeVisible();
  await code.fill("123");
  // Return after the coalescing window to exercise a second independent visit.
  await page.waitForTimeout(1100);
  const restored = loginResponse(page);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await restored;
  await expect(code).toHaveValue("123");
  await expect(page.getByText(m.login_code_invalid, { exact: true })).toBeVisible();
});

test("stale login tabs resume for the same address, and the top notice has no hydration shift", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.39.0.2") });
  try {
    const page = await context.newPage();
    await signUp(page, state().loginPolishInvite, "login_polish@example.com", { handle: "login_polish", mainLang: "en" });
    const scripts: string[] = [];
    const errors: string[] = [];
    page.on("request", request => { if (request.resourceType() === "script") scripts.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (/hydrat|server rendered HTML/i.test(message.text())) errors.push(message.text()); });
    const shots = path.resolve(".data/login-polish");
    fs.mkdirSync(shots, { recursive: true });
    const positions: unknown[] = [];
    for (const destination of ["/", "/settings"]) for (const width of [1280, 390]) {
      const scriptStart = scripts.length;
      await page.setViewportSize({ width, height: 900 });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let paused = true;
      const block = async (route: Route) => {
        if (paused && route.request().resourceType() === "script") await gate;
        await route.continue();
      };
      await page.route("**/*", block);
      const geometry = () => page.evaluate(() => {
        const header = document.querySelector("header")!.getBoundingClientRect();
        const main = document.querySelector("main")!.getBoundingClientRect();
        const notice = document.querySelector('[role="region"]')!.getBoundingClientRect();
        return { header: header.y, main: main.y, noticeBottom: notice.bottom, scrollY, overflow: document.documentElement.scrollWidth - innerWidth };
      });
      try {
        await page.goto(destination, { waitUntil: "commit" });
        await expect(page.getByText(m.passkey_prompt, { exact: true })).toBeVisible();
        await page.evaluate(async () => {
          await Promise.all([...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => link.sheet ? Promise.resolve() : new Promise(resolve => link.addEventListener("load", resolve, { once: true }))));
          await document.fonts.ready;
        });
        await captureScreenshot(page, { path: path.join(shots, `${destination === "/" ? "home" : "settings"}-${width}-before.png`) }, "e2e-login-polish");
        const before = await geometry();
        expect(before.noticeBottom).toBeLessThanOrEqual(before.header);
        expect(before.overflow).toBeLessThanOrEqual(0);
        paused = false; release();
        if (destination === "/") await expect(page.getByRole("button", { name: m.open_in_ai, exact: true })).toBeVisible();
        await waitForHydration(page);
        const after = await geometry();
        expect(Math.abs(after.header - before.header)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.main - before.main)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
        expect(after.overflow).toBeLessThanOrEqual(0);
        await captureScreenshot(page, { path: path.join(shots, `${destination === "/" ? "home" : "settings"}-${width}-after.png`) }, "e2e-login-polish");
        positions.push({ destination, width, before, after });
        if (destination === "/") expect(scripts.slice(scriptStart).some(url => /passkeys\.client|simplewebauthn/.test(url))).toBe(false);
      } finally { paused = false; release(); await page.unroute("**/*", block); }
    }
    expect(errors).toEqual([]);
    fs.writeFileSync(path.join(shots, "positions.json"), JSON.stringify(positions, null, 2));
    await page.getByRole("button", { name: m.passkey_prompt_later, exact: true }).click();
    await page.reload();
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
    const preference = (await context.cookies()).find(cookie => /tomola\.passkey-later-/.test(cookie.name))!;
    expect(preference.value).toMatch(/^\d+$/);
    expect(preference.expires - Date.now() / 1000).toBeGreaterThan(29.99 * 86400);
    expect(preference.expires - Date.now() / 1000).toBeLessThanOrEqual(30 * 86400);

    await page.goto("/invites/new");
    await page.getByLabel(m.invites_email, { exact: true }).fill("login_polish_other@example.com");
    await page.getByRole("button", { name: m.invites_submit, exact: true }).click();
    await expect(page.locator("main code")).toHaveText(/\/invite\//);
    const invitation = (await page.locator("main code").innerText()).trim();
    await logOut(page);
    await signUp(page, invitation, "login_polish_other@example.com", { handle: "login_polish_other", mainLang: "en" });
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toBeVisible();
    expect((await context.cookies()).some(cookie => cookie.name === preference.name)).toBe(true);

    const other = await context.newPage();
    for (const codeScreen of [false, true]) {
      await logOut(page);
      const next = codeScreen ? "/settings?from=stale-code" : "/";
      await page.goto(loginPath(next));
      await waitForClientRoute(page);
      let link = "";
      if (codeScreen) {
        link = await requestMagicLink(page, "login_polish@example.com");
        await expect(page.getByLabel(m.login_code_label, { exact: true })).toBeVisible();
      }
      await other.bringToFront();
      if (codeScreen) {
        await confirmMagicLink(other, link);
      } else {
        await other.goto(loginPath(next));
        const since = logSize();
        await other.getByLabel(m.login_email, { exact: true }).fill("login_polish@example.com");
        await other.getByRole("button", { name: m.login_submit, exact: true }).click();
        await other.getByLabel(m.login_code_label, { exact: true }).fill(await loginCodeFor("login_polish@example.com", since));
        await other.getByRole("button", { name: m.login_code_submit, exact: true }).click();
      }
      await expect(other).toHaveURL(new URL(next, state().baseURL).href);
      await page.bringToFront();
      // Headless Chromium keeps its tabs visible; deliver the return signal
      // explicitly after the other tab has established the shared session.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page).toHaveURL(new URL(next, state().baseURL).href);
      await expect(page.getByLabel(m.login_email, { exact: true })).toHaveCount(0);
      await expect(page.getByLabel(m.login_code_label, { exact: true })).toHaveCount(0);
    }
  } finally { await context.close(); }
});
