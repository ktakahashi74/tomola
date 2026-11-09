import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as m, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const pollNow = async (page: Page) => {
  const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/chat/changes"));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await response; await settle(page);
};

test("chat has one message tab stop, arrow navigation and a report dialog with focus restoration", async ({ page }) => {
  await useMember(page, "front_chat_tools_reader@example.com", "/v/chat-front-tools/chat"); await waitForClientRoute(page);
  const messages = page.locator("[data-chat-message]");
  await expect(messages).toHaveCount(3);
  await expect(page.locator('[data-chat-message][tabindex="0"]')).toHaveCount(1);
  await messages.first().focus(); await page.keyboard.press("ArrowDown");
  await expect(messages.nth(1)).toBeFocused();
  await expect(messages.first()).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End"); await expect(messages.last()).toBeFocused();
  await page.keyboard.press("Home"); await expect(messages.first()).toBeFocused();
  await expect(messages.locator('[role="status"]')).toHaveCount(0);
  await expect(messages.first().getByText("Front tools message 1", { exact: true })).toHaveAttribute("dir", "auto");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => messages.evaluateAll(elements => elements.some(element => element.contains(document.activeElement)))).toBe(false);
  await page.keyboard.press("Tab"); await expect(messages.first()).toBeFocused();
  const flag = messages.first().getByRole("link", { name: m.chat_reports_flag, exact: true });
  await flag.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: m.chat_reports_flag, exact: true });
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("link", { name: m.cancel, exact: true })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(flag).toBeFocused();
});

test("chat bounds retained messages and refetches both clipped edges without losing its reading anchor", async ({ page }) => {
  await useMember(page, "front_chat_window_reader@example.com", "/v/chat-front-window/chat?latest=1"); await waitForClientRoute(page);
  const messages = page.locator("[data-chat-message]");
  await expect(messages.last()).toHaveAttribute("data-chat-seq", "420");
  for (let i = 0; i < 8; i++) {
    const first = Number(await messages.first().getAttribute("data-chat-seq"));
    if (first === 1) break;
    const response = page.waitForResponse(response => new URL(response.url()).searchParams.has("before") && response.url().includes("/chat/changes"));
    await page.getByRole("link", { name: m.village_chat_previous, exact: true }).click(); await response;
    await expect.poll(async () => Number(await messages.first().getAttribute("data-chat-seq"))).toBeLessThan(first);
    expect(await messages.count()).toBeLessThanOrEqual(300);
  }
  await expect(messages.first()).toHaveAttribute("data-chat-seq", "1");
  const anchor = messages.nth(200); await anchor.scrollIntoViewIfNeeded();
  const anchorId = await anchor.getAttribute("id");
  for (let i = 0; i < 4 && Number(await messages.last().getAttribute("data-chat-seq")) < 420; i++) {
    const end = Number(await messages.last().getAttribute("data-chat-seq"));
    await page.getByRole("link", { name: m.village_chat_continue, exact: true }).last().click();
    await expect.poll(async () => Number(await messages.last().getAttribute("data-chat-seq"))).toBeGreaterThan(end);
    expect(await messages.count()).toBeLessThanOrEqual(300);
  }
  await expect(messages.last()).toHaveAttribute("data-chat-seq", "420");
  await expect(page.locator(`[id="${anchorId}"]`)).toHaveCount(1);
});

test("continuation trims old messages before read checks without moving the visible messages", async ({ page }) => {
  const reads: number[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/chat/read")) reads.push(Number(new URLSearchParams(request.postData() ?? "").get("seq")));
  });
  await useMember(page, "front_chat_trim_reader@example.com", "/v/chat-front-trim/chat?after=0"); await waitForClientRoute(page);
  const messages = page.locator("[data-chat-message]");
  for (let end = 50; end < 300; end += 50) {
    await expect(messages.last()).toHaveAttribute("data-chat-seq", String(end));
    await page.locator('a[href*="?after="]').last().evaluate(element => (element as HTMLElement).click());
  }
  await expect(messages).toHaveCount(300);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  await page.route("**/chat/changes?*forward=300*", async route => { arrived(); await gate; await route.continue(); });
  try {
    // Keep the viewport filled with loaded rows; appended rows begin below it.
    await page.locator('[data-chat-seq="290"]').evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.locator('a[href*="?after="]').last().evaluate(element => (element as HTMLElement).click());
    await requested; await settle(page);
    const visible = await page.locator("[data-chat-message]").evaluateAll(elements => {
      const bottom = document.querySelector("[data-chat-composer]")!.getBoundingClientRect().top;
      const top = Math.max(90, document.querySelector("[data-village-header]")!.getBoundingClientRect().bottom);
      const anchor = elements.find(element => element.getBoundingClientRect().bottom > 100)!;
      const markers = [...document.querySelectorAll<HTMLElement>("[data-chat-read-seq]")].filter(element => {
        const rect = element.getBoundingClientRect(); return rect.top >= top && rect.bottom <= bottom;
      });
      return { id: anchor.id, top: anchor.getBoundingClientRect().top, max: Math.max(...markers.map(element => Number(element.dataset.chatReadSeq))) };
    });
    const readCeiling = Math.max(visible.max, ...reads);
    await page.clock.install();
    release(); await expect(messages.last()).toHaveAttribute("data-chat-seq", "350");
    await page.clock.runFor(500); await settle(page);
    expect.soft(await page.locator(`[id="${visible.id}"]`).evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(visible.top, 1);
    expect(await page.locator('[data-chat-seq="301"]').evaluate(element => element.getBoundingClientRect().top >= document.querySelector("[data-chat-composer]")!.getBoundingClientRect().top)).toBe(true);
    expect(Math.max(...reads)).toBeLessThanOrEqual(readCeiling);
    expect(await messages.count()).toBe(300);
  } finally { release(); }
});

test("live arrivals preserve the visible anchor when the bounded window removes its oldest messages", async ({ page, browser }) => {
  await useMember(page, "front_chat_live_reader@example.com", "/v/chat-front-live/chat?latest=1"); await waitForClientRoute(page);
  const messages = page.locator("[data-chat-message]");
  while (await messages.first().getAttribute("data-chat-seq") !== "1") {
    const first = Number(await messages.first().getAttribute("data-chat-seq"));
    await page.getByRole("link", { name: m.village_chat_previous, exact: true }).evaluate(element => (element as HTMLElement).click());
    await expect.poll(async () => Number(await messages.first().getAttribute("data-chat-seq"))).toBeLessThan(first);
  }
  await page.locator('[data-chat-seq="220"]').evaluate(element => element.scrollIntoView({ block: "center" })); await settle(page);
  const anchor = await messages.evaluateAll(elements => {
    const first = elements.find(element => element.getBoundingClientRect().bottom > 100)!;
    return { id: first.id, top: first.getBoundingClientRect().top };
  });
  const context = await browser.newContext(); const writer = await context.newPage();
  try {
    await useMember(writer, "front_chat_live_writer@example.com", "/v/chat-front-live/chat"); await waitForClientRoute(writer);
    for (let seq = 301; seq <= 302; seq++) {
      await writer.getByLabel(m.village_chat_body, { exact: true }).fill(`A live arrival ${seq}`);
      await writer.getByRole("button", { name: m.village_chat_send, exact: true }).click();
      await expect(writer.getByRole("log")).toContainText(`A live arrival ${seq}`);
      await pollNow(page);
      await expect(messages.last()).toHaveAttribute("data-chat-seq", String(seq));
      await expect(messages.first()).toHaveAttribute("data-chat-seq", String(seq - 299));
      expect(await page.locator(`[id="${anchor.id}"]`).evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(anchor.top, 1);
    }
  } finally { await context.close(); }
});

test("a successful superseded poll clears reconnecting before the next poll completes", async ({ page }) => {
  await useMember(page, "front_chat_recovery_reader@example.com", "/v/chat-front-recovery/chat?before=56"); await waitForClientRoute(page);
  await page.route("**/chat/changes?*", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await pollNow(page); await pollNow(page);
  await expect(page.getByText(m.village_chat_reconnecting, { exact: true })).toBeVisible();
  await page.unroute("**/chat/changes?*");
  let release!: () => void, arrived!: () => void, finish!: () => void, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  const next = new Promise<void>(resolve => { finish = resolve; });
  await page.route("**/chat/changes?*", async route => {
    if (new URL(route.request().url()).searchParams.has("forward")) { await route.continue(); return; }
    if (first) { first = false; const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); }
    else { await next; await route.continue(); }
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await requested;
    await page.locator('a[href*="?after="]').last().evaluate(element => (element as HTMLElement).click());
    await expect(page.locator("[data-chat-message]").last()).toHaveAttribute("data-chat-seq", "60");
    release();
    await expect(page.getByText(m.village_chat_reconnecting, { exact: true })).toHaveCount(0);
  } finally { release(); finish(); }
});

test("unchanged chat polls keep the read observer and repeated failures show a recoverable connection status", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = IntersectionObserver;
    Object.assign(window, { chatReadObservers: 0 });
    window.IntersectionObserver = class extends Original {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        if (options?.rootMargin?.startsWith("-90px")) (window as unknown as { chatReadObservers: number }).chatReadObservers++;
      }
    };
  });
  await useMember(page, "front_chat_poll_reader@example.com", "/v/chat-front-poll/chat"); await waitForClientRoute(page);
  await expect(page.getByRole("log")).toContainText("Front poll message 3");
  await pollNow(page);
  const count = await page.evaluate(() => (window as unknown as { chatReadObservers: number }).chatReadObservers);
  await pollNow(page); await pollNow(page);
  expect(await page.evaluate(() => (window as unknown as { chatReadObservers: number }).chatReadObservers)).toBe(count);
  await page.route("**/chat/changes?*", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await pollNow(page); await pollNow(page);
  await expect(page.getByRole("status").filter({ hasText: m.village_chat_reconnecting })).toBeVisible();
  await page.unroute("**/chat/changes?*"); await pollNow(page);
  await expect(page.getByText(m.village_chat_reconnecting, { exact: true })).toHaveCount(0);
});

test("editor media stays inside its form and document navigation keeps its reserved height", async ({ page }) => {
  await useMember(page, "front_editor@example.com", "/t/new");
  const form = page.locator("form", { has: page.getByLabel(m.field_body, { exact: true }) }); await waitForFormReady(form);
  await expect(form.locator("[data-media-slot]")).toBeVisible();
  await page.getByLabel(m.field_body, { exact: true }).fill("A preserved editor body.");
  await page.getByLabel(m.field_title, { exact: true }).fill("A preserved title");
  await expect(form.locator("[data-media-slot]")).toHaveCount(1);
  await expect(page.getByLabel(m.field_body, { exact: true })).toHaveValue("A preserved editor body.");
  await expect(page.locator('link[rel="stylesheet"][href*="katex"]')).toHaveCount(1);
  for (const width of [1280, 390]) for (const path of ["/principles", "/why"]) {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const requested = new Promise<void>(resolve => { arrived = resolve; });
    await page.route("**/navigation-header", async route => { arrived(); await gate; await route.continue(); });
    try {
      await page.goto(path); await requested;
      const heading = page.getByRole("heading", { level: 1 }).first();
      await expect(heading).toBeVisible();
      const before = await heading.evaluate(element => element.getBoundingClientRect().top);
      release(); await expect(page.locator("[data-member-menu-trigger]")).toBeVisible();
      expect(await heading.evaluate(element => element.getBoundingClientRect().top)).toBe(before);
    } finally { release(); await page.unroute("**/navigation-header"); }
  }
  await page.goto("/login");
  await expect(page.locator('link[rel="stylesheet"][href*="katex"]')).toHaveCount(0);
});
