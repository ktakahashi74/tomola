import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, uiMessages, useMember, waitForClientRoute } from "./helpers";
const enabled = process.env.WEB_PUSH === "1";
type Display = "off" | "active" | "blocked" | "unsupported" | "install" | "reconnect" | "login";
const browserId = "79bdc84e-ce07-4f02-8c11-dbcdbb0c982b";
const otherId = "cf628071-68af-40b8-b0c2-6431f0580327";
async function mockBrowser(page: Page) {
  await page.addInitScript(({ browserId }) => {
    const fixture = { permission: "default" as NotificationPermission, supported: true, ios: false, subscribed: false, workerReady: true, resolveWorker: () => {}, gesture: false, requestResult: "granted" as NotificationPermission };
    (window as unknown as { pushFixture: typeof fixture }).pushFixture = fixture;
    class FakeNotification {
      static get permission() { return fixture.permission; }
      static requestPermission() { fixture.gesture = navigator.userActivation.isActive; fixture.permission = fixture.requestResult; return Promise.resolve(fixture.permission); }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
    Object.defineProperty(window, "PushManager", { configurable: true, get: () => fixture.supported ? function () {} : undefined });
    const ua = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => fixture.ios ? "iPhone Version/17.0 Mobile Safari/605.1" : ua });
    const subscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/wp/browser-test", keys: { p256dh: "fixture", auth: "fixture" } }),
      unsubscribe: async () => { fixture.subscribed = false; localStorage.setItem("push-unsubscribed", String(Number(localStorage.getItem("push-unsubscribed") ?? 0) + 1)); return true; } };
    const registration = { pushManager: { getSubscription: async () => fixture.subscribed ? subscription : null,
      subscribe: async () => { fixture.subscribed = true; return subscription; } }, getNotifications: async () => [{ close: () => localStorage.setItem("push-closed", "1") }] };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => registration, register: async () => registration, get ready() { return fixture.workerReady ? Promise.resolve(registration) : new Promise(resolve => { fixture.resolveWorker = () => resolve(registration); }); } } });
    if (!localStorage.getItem("tomola:push-browser")) localStorage.setItem("tomola:push-browser", JSON.stringify({ id: browserId, secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", userId: "fixture-owner" }));
  }, { browserId });
  const state = { display: "off" as Display, other: true, hold: false, holdState: false, failState: false, limited: false, current: false, reason: null as string | null, publicKey: process.env.VAPID_PUBLIC_KEY ?? "", release: () => {} };
  const calls: string[] = [];
  const waiting: Array<() => void> = [];
  const releaseState = () => { state.holdState = false; waiting.splice(0).forEach(resolve => resolve()); };
  await page.route(/\/push\/(?:state|subscribe|unsubscribe|test)$/, async route => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1)!;
    calls.push(operation);
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (state.display === "login") return json({ error: "login" }, 401);
    if (operation === "subscribe") {
      if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
      state.current = true; state.reason = null; state.display = "active"; return json({ ok: true });
    }
    if (operation === "unsubscribe") {
      const input = route.request().postDataJSON();
      if (input.all || input.id === browserId) state.current = false;
      if (input.all || input.id === otherId) state.other = false;
      return json({ ok: true });
    }
    if (operation === "test") return state.limited ? json({ error: "limit" }, 429) : json({ ok: true });
    if (state.holdState) await new Promise<void>(resolve => waiting.push(resolve));
    if (state.failState) return json({ error: "failed" }, 503);
    const registrations = [state.current ? { id: browserId, browser: "Chrome", os: "Linux", createdAt: "2026-11-08T00:00:00Z", stoppedReason: null, authorizedUntil: "2026-12-08T00:00:00Z" } : null,
      state.other ? { id: otherId, browser: "Firefox", os: "Windows", createdAt: "2026-11-07T00:00:00Z", stoppedReason: null, authorizedUntil: "2026-12-08T00:00:00Z" } : null].filter(Boolean);
    return json({ userId: "fixture-owner", current: state.current ? { id: browserId, stoppedReason: state.reason, matchesSubscription: state.display === "active", vapidPublicKey: state.publicKey } : null, registrations });
  });
  async function display(value: Display) {
    state.display = value; state.current = value === "active" || value === "reconnect";
    await page.evaluate(value => {
      const f = (window as unknown as { pushFixture: { permission: string; supported: boolean; ios: boolean; subscribed: boolean } }).pushFixture;
      f.permission = value === "blocked" ? "denied" : value === "active" || value === "reconnect" ? "granted" : "default";
      f.supported = value !== "unsupported"; f.ios = value === "install"; f.subscribed = value === "active";
      if (value === "unsupported") delete (window as unknown as { PushManager?: unknown }).PushManager;
      else if (!("PushManager" in window)) Object.defineProperty(window, "PushManager", { configurable: true, value: function () {} });
      window.dispatchEvent(new Event("tomola:push-state"));
    }, value);
    await expect(page.locator("#settings-push:visible")).toHaveAttribute("data-push-state", value);
  }
  return { state, calls, display, releaseState };
}

// All fixtures are seeded in both modes. These scenarios mock only browser APIs
// and same-origin push endpoints; authorization and delivery run in unit tests.
for (const lang of ["ja", "en"] as const) for (const width of [390, 1366]) {
  test(`notification states at ${width} in ${lang}`, async ({ browser }) => {
    test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: lang, extraHTTPHeaders: clientHeaders(`10.220.${lang === "ja" ? 1 : 2}.${width === 390 ? 1 : 2}`) });
    try {
      const page = await context.newPage(); const fixture = await mockBrowser(page); fixture.state.holdState = true;
      await useMember(page, `push_ui_${width}_${lang}@example.com`, "/settings#settings-push"); await waitForClientRoute(page);
      const section = page.locator("#settings-push:visible");
      await expect(section).toHaveAttribute("data-push-state", "checking");
      await section.scrollIntoViewIfNeeded(); await captureScreenshot(page, { path: `${lang}-${width}-checking.png`, fullPage: false }, ".");
      fixture.releaseState();
      await expect(section).toHaveAttribute("data-push-state", "off");
      for (const display of ["off", "active", "blocked", "install", "unsupported", "reconnect", "login"] as const) {
        await fixture.display(display); await section.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await captureScreenshot(page, { path: `${lang}-${width}-${display}.png`, fullPage: false }, ".");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await fixture.display("off"); fixture.state.hold = true;
      const m = await uiMessages(page); await section.getByRole("button", { name: m.push_enable, exact: true }).click();
      await expect(section).toHaveAttribute("data-push-state", "registering");
      await section.scrollIntoViewIfNeeded(); await captureScreenshot(page, { path: `${lang}-${width}-registering.png`, fullPage: false }, ".");
      await expect.poll(() => fixture.calls.includes("subscribe")).toBe(true); fixture.state.release();
      await expect(section).toHaveAttribute("data-push-state", "active");
    } finally { await context.close(); }
  });
}
test("opt-in requires a click, tests use the stored registration, and every browser can be stopped", async ({ page }) => {
  test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
  const fixture = await mockBrowser(page); await useMember(page, "push_flow@example.com", "/settings#settings-push"); await waitForClientRoute(page);
  const m = await uiMessages(page); const section = page.locator("#settings-push:visible"); await expect(section).toHaveAttribute("data-push-state", "off");
  expect(fixture.calls).not.toContain("subscribe");
  await section.getByRole("button", { name: m.push_enable, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "active");
  expect(await page.evaluate(() => (window as unknown as { pushFixture: { gesture: boolean } }).pushFixture.gesture)).toBe(true);
  for (const button of await section.getByRole("button").all()) { const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); }
  await section.getByRole("button", { name: m.push_test, exact: true }).click(); await expect(section.getByRole("status")).toContainText(m.push_test_accepted);
  await section.getByRole("listitem").filter({ hasText: "Firefox" }).getByRole("button", { name: m.push_stop, exact: true }).click(); await expect(section.getByRole("listitem")).toHaveCount(0);
  await section.getByRole("button", { name: m.push_stop_all, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "off");
  fixture.state.reason = "expired"; await fixture.display("reconnect");
  await section.getByRole("button", { name: m.push_enable, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "active");
  await section.getByRole("button", { name: m.push_stop_all, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "off");
  expect(await page.evaluate(() => Number(localStorage.getItem("push-unsubscribed")))).toBeGreaterThan(0); expect(await page.evaluate(() => localStorage.getItem("push-closed"))).toBe("1");
  await page.evaluate(() => { (window as unknown as { pushFixture: { requestResult: string } }).pushFixture.requestResult = "denied"; });
  await section.getByRole("button", { name: m.push_enable, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "blocked");
  await section.getByRole("button", { name: m.push_refresh, exact: true }).click(); await expect(section.getByRole("status")).toContainText(m.push_checked);
});
test("logout unsubscribes and includes the browser identity in the submitted form", async ({ page }) => {
  test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
  await mockBrowser(page); await useMember(page, "push_logout@example.com", "/settings#settings-push"); await waitForClientRoute(page);
  const m = await uiMessages(page); const section = page.locator("#settings-push:visible");
  await expect(section).toHaveAttribute("data-push-state", "off");
  await section.getByRole("button", { name: m.push_enable, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "active");
  await page.locator("[data-member-menu-trigger]").click();
  const request = page.waitForRequest(request => /^\/logout(?:\.data)?$/.test(new URL(request.url()).pathname) && request.method() === "POST");
  await page.getByRole("menuitem", { name: m.nav_logout, exact: true }).click();
  const submitted = await request; expect(submitted.postData()).toContain("push-id"); expect(submitted.postData()).toContain(browserId);
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("push-unsubscribed")))).toBeGreaterThan(0);
});
test("closed configuration exposes neither settings nor push endpoints", async ({ page }) => {
  test.skip(enabled, "This scenario checks the closed configuration");
  const requests: string[] = [];
  page.on("request", request => { if (/\/push\//.test(new URL(request.url()).pathname) || /(?:lifecycle\.client|push-settings)/.test(request.url())) requests.push(request.url()); });
  await useMember(page, "push_closed@example.com", "/settings"); await waitForClientRoute(page); await expect(page.locator("#settings-push:visible")).toHaveCount(0);
  expect(requests).toEqual([]);
  const response = await page.request.post("/push/state", { headers: { Origin: new URL(page.url()).origin }, data: {} }); expect(response.status()).toBe(404);
});

test("reconciliation ignores unrelated storage and route changes", async ({ page }) => {
  test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
  const fixture = await mockBrowser(page); await useMember(page, "push_reconcile@example.com", "/settings#settings-push"); await waitForClientRoute(page);
  const section = page.locator("#settings-push:visible"); await expect(section).toHaveAttribute("data-push-state", "off");
  const before = fixture.calls.length;
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "tomola:draft" })));
  await page.waitForTimeout(150); expect(fixture.calls).toHaveLength(before);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "tomola:push-browser" })));
  await expect.poll(() => fixture.calls.length).toBeGreaterThan(before);
  await page.locator('a[href="/"]:visible').first().click(); await waitForClientRoute(page);
  const after = fixture.calls.length;
  await page.locator('a[href="/notifications"]:visible').first().click(); await waitForClientRoute(page);
  expect(fixture.calls).toHaveLength(after);
});
test("opt-in waits for an active worker and suppresses reconciliation until registration completes", async ({ page }) => {
  test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
  const fixture = await mockBrowser(page); await useMember(page, "push_ready@example.com", "/settings#settings-push"); await waitForClientRoute(page);
  const section = page.locator("#settings-push:visible"); const m = await uiMessages(page); await expect(section).toHaveAttribute("data-push-state", "off");
  await page.evaluate(() => { (window as unknown as { pushFixture: { workerReady: boolean } }).pushFixture.workerReady = false; });
  await section.getByRole("button", { name: m.push_enable, exact: true }).click();
  await expect(section).toHaveAttribute("data-push-state", "registering"); expect(fixture.calls).not.toContain("subscribe");
  const count = fixture.calls.length;
  await page.evaluate(() => { window.dispatchEvent(new StorageEvent("storage", { key: "tomola:push-browser" })); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(150); expect(fixture.calls).toHaveLength(count);
  fixture.state.hold = true;
  await page.evaluate(() => (window as unknown as { pushFixture: { resolveWorker: () => void } }).pushFixture.resolveWorker());
  await expect.poll(() => fixture.calls.includes("subscribe")).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(150); expect(fixture.calls).toHaveLength(count + 1);
  await page.locator('a[href="/"]:visible').first().click(); await waitForClientRoute(page);
  await page.goBack(); await waitForClientRoute(page);
  await expect(section).toHaveAttribute("data-push-state", "checking");
  fixture.state.release(); await expect(section).toHaveAttribute("data-push-state", "active");
});
test("failed checks stay failed and send rate limits explain the limit", async ({ page }) => {
  test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
  const fixture = await mockBrowser(page); await useMember(page, "push_errors@example.com", "/settings#settings-push"); await waitForClientRoute(page);
  const section = page.locator("#settings-push:visible"); const m = await uiMessages(page); await expect(section).toHaveAttribute("data-push-state", "off");
  fixture.state.failState = true;
  await section.getByRole("button", { name: m.push_refresh, exact: true }).click();
  await expect(section.getByRole("status")).toContainText(m.push_error); await expect(section.getByRole("status")).not.toContainText(m.push_checked);
  fixture.state.failState = false; await fixture.display("active"); fixture.state.limited = true;
  await section.getByRole("button", { name: m.push_test, exact: true }).click(); await expect(section.getByRole("status")).toContainText(m.error_rate_limited);
  const stop = section.getByRole("listitem").getByRole("button"); await expect(stop).toHaveAccessibleDescription(/Firefox.*Windows/);
  for (const suffix of ["SamsungBrowser/25.0", "EdgA/123.0", "UnknownBrowser/1.0"]) {
    await fixture.display("off");
    await page.evaluate(suffix => Object.defineProperty(navigator, "userAgent", { configurable: true,
      value: `Mozilla/5.0 (Linux; Android 14) Chrome/123.0 Mobile Safari/537.36 ${suffix}` }), suffix);
    await fixture.display("blocked");
    await expect(section).toContainText(m.push_restore_browser);
    await expect(section).not.toContainText(m.push_restore_android);
  }
  await captureScreenshot(page, { path: "en-android-browser-permissions.png", fullPage: false }, ".");
});
test("only session forms carry the push capability and rejected deletion keeps the subscription", async ({ page }) => {
  test.skip(!enabled, "This scenario needs the explicitly enabled test configuration");
  await mockBrowser(page); await useMember(page, "push_forms@example.com", "/settings#settings-push"); await waitForClientRoute(page);
  const m = await uiMessages(page); const section = page.locator("#settings-push:visible");
  await expect(section).toHaveAttribute("data-push-state", "off");
  await section.getByRole("button", { name: m.push_enable, exact: true }).click(); await expect(section).toHaveAttribute("data-push-state", "active");
  const result = await page.evaluate(() => {
    const collect = (path: string, intent?: string) => {
      const form = document.createElement("form"); form.action = path;
      if (intent) { const input = document.createElement("input"); input.name = "intent"; input.value = intent; form.append(input); }
      document.body.append(form); const data = new FormData(form); form.remove(); return data.has("push-secret");
    };
    const form = document.createElement("form"); form.action = "/settings/delete-account"; document.body.append(form); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.remove();
    return [collect("/settings/save"), collect("/settings/delete-account"), collect("/settings", "email-pref"), collect("/settings", "revoke-other-sessions"), collect("/logout")];
  });
  expect(result).toEqual([false, false, false, true, true]);
  expect(await page.evaluate(() => localStorage.getItem("push-unsubscribed"))).toBeNull();
});
