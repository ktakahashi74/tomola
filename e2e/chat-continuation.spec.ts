import { expect, test } from "@playwright/test";
import { enMessages as m, formatMessage, useMember, uiMessages, waitForClientRoute } from "./helpers";

test("an unread window continues in place and counts unread messages beyond its end", async ({ page }) => {
  const reads: number[] = [];
  page.on("request", request => {
    if (request.method() !== "POST" || !request.url().includes("/chat/read")) return;
    const form = new URLSearchParams(request.postData() ?? "");
    if (form.get("intent") === "read") reads.push(Number(form.get("seq")));
  });
  await useMember(page, "chat_next_continuation_reader@example.com", "/v/chat-next-continuation/chat"); await waitForClientRoute(page);
  await expect(page.getByRole("link", { name: formatMessage(m.village_chat_new_messages, { count: 84 }), exact: true })).toBeVisible();
  const polls: string[] = [];
  page.on("request", request => { if (request.url().includes("/chat/changes?")) polls.push(request.url()); });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => polls.length).toBeGreaterThan(0);
  expect(polls.filter(url => new URL(url).searchParams.has("counts"))).toHaveLength(0);
  const counted = page.waitForResponse(response => response.url().includes("/chat/changes?") && new URL(response.url()).searchParams.get("counts") === "1");
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 31_000; document.dispatchEvent(new Event("visibilitychange")); });
  await counted;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => polls.filter(url => new URL(url).searchParams.has("counts")).length).toBe(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstContinuation = true;
  await page.route("**/chat/changes?*forward=*", async route => { if (firstContinuation) { firstContinuation = false; await gate; await route.fulfill({ status: 503, body: "Unavailable" }); } else await route.continue(); });
  const more = page.locator('a[href*="?after="]');
  await more.scrollIntoViewIfNeeded();
  const anchor = page.locator("[data-chat-message]").filter({ hasText: "Next continuation message 36" });
  const top = await anchor.evaluate(element => element.getBoundingClientRect().top);
  expect(Math.max(0, ...reads)).toBeLessThanOrEqual(36);
  release();
  await expect(page.getByRole("status").filter({ hasText: m.village_chat_history_retry })).toBeVisible();
  await more.click();
  await expect(page.locator("[data-chat-message]")).toHaveCount(86);
  expect(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThan(1);
  expect(Math.max(0, ...reads)).toBeLessThan(86);
  await expect(page.getByRole("link", { name: formatMessage(m.village_chat_new_messages, { count: 34 }), exact: true })).toBeVisible();
  await more.scrollIntoViewIfNeeded(); await expect(page.locator("[data-chat-message]")).toHaveCount(120);
  await expect(more).toHaveCount(0);
  await expect(page).toHaveURL(/\/v\/chat-next-continuation\/chat$/);
  expect(await page.locator("[data-chat-message] > p.whitespace-pre-wrap").allTextContents()).toEqual(Array.from({ length: 120 }, (_, i) => `Next continuation message ${i + 1}`));
});

test("sending retains loaded history, the original-reading choice and an open report without shifting its message", async ({ page }) => {
  await useMember(page, "chat_next_state_reader@example.com", "/v/chat-next-state/chat"); await waitForClientRoute(page);
  await expect(page.locator("#chat-unread")).toBeInViewport();
  await page.getByRole("link", { name: m.village_chat_previous, exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator("[data-chat-message]")).toHaveCount(66);
  const message = page.locator("[data-chat-message]").filter({ hasText: "Next state message 35" });
  await message.scrollIntoViewIfNeeded(); await message.hover();
  const top = await message.evaluate(element => element.getBoundingClientRect().top);
  await message.getByRole("link", { name: m.chat_reports_flag, exact: true }).click();
  const report = page.getByRole("dialog", { name: m.chat_reports_flag, exact: true });
  await expect(report).toBeVisible();
  expect(Math.abs(await message.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThan(1);
  await page.keyboard.press("Escape");
  await expect(report).toHaveCount(0);
  expect(Math.abs(await message.evaluate(element => element.getBoundingClientRect().top) - top)).toBeLessThan(1);
  // One message of this chat is shown by its translation, so the switch to the originals is there; the choice is made before sending.
  await page.getByRole("button", { name: m.village_chat_originals, exact: true }).click();
  await expect(page.getByRole("button", { name: m.village_chat_translations, exact: true })).not.toHaveAttribute("aria-pressed");
  const log = await page.getByRole("log").elementHandle();
  await page.getByLabel(m.village_chat_body, { exact: true }).fill("A first send with reading state");
  // Start the send before opening the modal. Its response must preserve the
  // dialog draft; controls behind an open dialog are deliberately unavailable.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const answer = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/chat.data"));
  await page.route("**/chat.data", async route => { await gate; await route.continue(); });
  try {
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await message.hover(); await message.getByRole("link", { name: m.chat_reports_flag, exact: true }).click();
    await report.getByLabel(m.flag_note, { exact: true }).fill("Keep this draft while I send");
    release(); await answer;
    // Response headers precede the redirect loader and its rendered message.
    await waitForClientRoute(page);
  } finally { release(); await page.unroute("**/chat.data"); }
  expect(await log!.evaluate(element => element.isConnected)).toBe(true);
  await expect(report.getByLabel(m.flag_note, { exact: true })).toHaveValue("Keep this draft while I send");
  await report.getByRole("link", { name: m.cancel, exact: true }).click();
  await expect(report).toHaveCount(0);
  await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: "A first send with reading state" })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("Next state message 25");
  // The choice of reading the originals is kept through the send.
  await expect(page.getByRole("button", { name: m.village_chat_translations, exact: true })).toBeVisible();
  const earlier = page.getByRole("link", { name: m.village_chat_previous, exact: true });
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect(page.getByRole("log")).toContainText("Next state message 70");
  const reportId = await message.getAttribute("data-chat-message");
  await page.goto(`/v/chat-next-state/chat?report=${reportId}`); await waitForClientRoute(page);
  await expect(report).toBeVisible();
  await report.getByRole("link", { name: m.cancel, exact: true }).click();
  await expect(report).toHaveCount(0);
  await expect(page.locator(`[data-chat-message="${reportId}"]`)).toBeInViewport();
});

test("native navigation reads the next window instead of skipping to the newest messages", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US" });
  try {
    const page = await context.newPage();
    await useMember(page, "chat_next_native_reader@example.com", "/v/chat-next-native/chat?lang=ja&manage=1");
    await expect(page.getByRole("log")).toContainText("Next native message 36");
    await page.locator('a[href*="?after="]').click();
    await expect(page).toHaveURL(/\?after=36/);
    await expect(page.locator("[data-chat-message]").first()).toContainText("Next native message 37");
    await expect(page.locator("[data-chat-message]").last()).toContainText("Next native message 86");
    expect(new URL(page.url()).searchParams.get("lang")).toBe("ja");
    expect(new URL(page.url()).searchParams.has("manage")).toBe(false);
    await page.goto("/v/chat-next-native/chat?after=999&lang=ja&manage=1");
    const latest = page.getByRole("link", { name: (await uiMessages(page)).village_chat_latest, exact: false });
    await expect(latest).toBeVisible();
    await latest.click();
    expect(new URL(page.url()).searchParams.get("lang")).toBe("ja");
    await expect(page.locator("[data-chat-message]").last()).toContainText("Next native message 120");
  } finally { await context.close(); }
});

test("calendar hydration tolerates a different timezone and browser ICU formatting", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ar-EG", timezoneId: "Pacific/Honolulu" });
  try {
    await context.addInitScript(() => {
      const Original = Intl.DateTimeFormat;
      Intl.DateTimeFormat = new Proxy(Original, { construct(target, args) {
        const formatter = Reflect.construct(target, args);
        return new Proxy(formatter, { get(object, property) {
          const value = Reflect.get(object, property, object);
          if (property === "format" && (args[1]?.dateStyle || args[1]?.month === "long")) return (date: Date) => `Browser calendar: ${value(date)}`;
          return typeof value === "function" ? value.bind(object) : value;
        } });
      } });
    });
    const page = await context.newPage(); const warnings: string[] = [];
    page.on("console", message => { if (/hydrat|did not match/i.test(message.text())) warnings.push(message.text()); });
    page.on("pageerror", error => { if (/hydrat|did not match/i.test(error.message)) warnings.push(error.message); });
    await useMember(page, "chat_next_calendar_reader@example.com", "/v/chat-next-calendar/chat"); await waitForClientRoute(page);
    const time = page.locator("[data-chat-message] time").first();
    await expect(time).toHaveText("13:30");
    await expect(time).toHaveAttribute("title", /^Browser calendar:/);
    expect(warnings).toEqual([]);
  } finally { await context.close(); }
});

test("hovering own and other messages leaves the following message in place", async ({ page }) => {
  await useMember(page, "chat_next_hover_reader@example.com", "/v/chat-next-hover/chat"); await waitForClientRoute(page);
  const messages = page.locator("[data-chat-message]");
  for (const index of [0, 1]) {
    await page.mouse.move(0, 0);
    const next = messages.nth(index + 1);
    const before = await next.evaluate(element => element.getBoundingClientRect().top);
    await messages.nth(index).hover();
    expect(await next.evaluate(element => element.getBoundingClientRect().top)).toBe(before);
  }
});


test("a short send preserves unread messages and mentions across a gap until history fills it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.clock.install();
  const reads: import("@playwright/test").Request[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/chat/read") && new URLSearchParams(request.postData() ?? "").get("intent") === "read") reads.push(request); });
  const flushReads = async () => { await page.clock.runFor(500); await Promise.all(reads.map(request => request.response())); };
  const unread = async () => (await (await page.request.get("/v/chat-next-sendread/chat/changes?since=221")).json()).unread;
  const mentions = async () => (await (await page.request.get("/navigation-header")).json()).unreadNotifications;
  // Incidental continuation cannot fill the gap before the reader chooses its link.
  let allowForward = false;
  await page.route("**/chat/changes?*forward=*", route => allowForward ? route.continue() : route.fulfill({ status: 503, body: "Continuation unavailable" }));
  await useMember(page, "chat_next_sendread_reader@example.com", "/v/chat-next-sendread/chat"); await waitForClientRoute(page);
  await expect(page.locator("#chat-unread")).toBeInViewport();
  await flushReads();
  expect(await mentions()).toBe(1);
  await page.getByLabel(m.village_chat_body, { exact: true }).fill("A short reply across the unread gap");
  // Positioning the pointer can load history; this scenario checks the unread gap after a send.
  await page.getByLabel(m.village_chat_body, { exact: true }).press("Enter");
  const own = page.locator("[data-chat-message]").filter({ hasText: "A short reply across the unread gap" });
  await expect(own).toBeInViewport();
  await expect(page.locator("[data-chat-message]").filter({ hasText: "Next sendread message 220" })).toBeInViewport();
  await expect(own.locator("[data-chat-read-seq]")).toHaveCount(0);
  await expect(page.getByRole("log")).not.toContainText("Next sendread message 60");
  await flushReads();
  expect(await unread()).toBeGreaterThan(0);
  expect(await mentions()).toBe(1);
  expect(Math.max(0, ...reads.map(request => Number(new URLSearchParams(request.postData() ?? "").get("seq"))))).toBeLessThanOrEqual(36);
  const gap = page.locator("[data-chat-gap]");
  await expect(gap).toHaveCount(1);
  await expect(gap.getByRole("separator")).toBeVisible();
  await expect(gap.getByRole("link", { name: m.village_chat_continue, exact: true })).toHaveAttribute("href", "/v/chat-next-sendread/chat?after=36");
  await gap.getByRole("link", { name: m.village_chat_continue, exact: true }).click();
  await expect(gap.getByRole("status")).toHaveText(m.village_chat_history_retry);
  allowForward = true;
  for (const [after, end] of [[36, 86], [86, 136], [136, 186]]) {
    await expect(gap.getByRole("link", { name: m.village_chat_continue, exact: true })).toHaveAttribute("href", `/v/chat-next-sendread/chat?after=${after}`);
    await gap.getByRole("link", { name: m.village_chat_continue, exact: true }).click();
    await expect(page.getByRole("log")).toContainText(`Next sendread message ${end}`);
    if (end < 172) {
      await expect(gap).toHaveCount(1);
      await flushReads();
      expect(Math.max(0, ...reads.map(request => Number(new URLSearchParams(request.postData() ?? "").get("seq"))))).toBeLessThanOrEqual(end);
    }
  }
  await expect(gap).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("Next sendread message 137");
  await own.scrollIntoViewIfNeeded();
  await flushReads();
  await expect.poll(async () => { await flushReads(); return unread(); }).toBe(0);
  await expect.poll(async () => { await flushReads(); return mentions(); }).toBe(0);
});


test("a refused send does not retain history when the next explicit latest window opens", async ({ page }) => {
  await useMember(page, "chat_next_failed_reader@example.com", "/v/chat-next-failed/chat"); await waitForClientRoute(page);
  await page.route("**/chat.data", async route => {
    const request = route.request(); const form = new URLSearchParams(request.postData() ?? "");
    if (request.method() === "POST" && form.get("intent") === "send") { form.set("body", " "); await route.continue({ postData: form.toString() }); }
    else await route.continue();
  });
  await page.getByLabel(m.village_chat_body, { exact: true }).fill("A refused reply");
  const refused = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/chat.data")
    && new URLSearchParams(response.request().postData() ?? "").get("intent") === "send");
  // Keep this refusal/window-reset check independent of pointer scrolling,
  // which can load the next historical page while positioning the button.
  await page.getByLabel(m.village_chat_body, { exact: true }).press("Enter");
  expect((await refused).status()).toBe(400);
  await expect(page.getByRole("alert")).toHaveText(m.village_chat_invalid);
  await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("A refused reply");
  await page.locator('a[href*="?latest=1#chat-bottom"]').click();
  await expect(page.locator("[data-chat-message]")).toHaveCount(50);
  await expect(page.locator("[data-chat-message]").first()).toContainText("Next failed message 71");
  const previousRequest = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/chat/changes") && new URL(request.url()).searchParams.has("before"));
  await page.getByRole("link", { name: m.village_chat_previous, exact: true }).scrollIntoViewIfNeeded();
  expect(new URL((await previousRequest).url()).searchParams.has("after")).toBe(false);
});


test("arrivals while reading the bottom do not flash unread badges, but a refused receipt restores the count", async ({ page, browser }) => {
  await page.clock.install();
  await useMember(page, "chat_next_readlive_reader@example.com", "/v/chat-next-readlive/chat"); await waitForClientRoute(page);
  await expect(page.locator("[data-chat-message]").last()).toBeInViewport();
  await expect.poll(async () => { await page.clock.runFor(250); return (await (await page.request.get("/v/chat-next-readlive/chat/changes?since=4")).json()).unread; }).toBe(0);
  // News in a chat is a dot on its tab and on its entrance in the side column.
  const dots = '[data-village-header] > nav .bg-unread, [data-site-navigation] a[href="/v/chat-next-readlive/chat"] .bg-unread';
  await page.evaluate(dots => {
    const state = window as typeof window & { unreadFlashes: string[] }; state.unreadFlashes = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector(dots)) state.unreadFlashes.push("dot");
    });
    for (const element of document.querySelectorAll("[data-village-header], [data-site-navigation]")) observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
  }, dots);
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failed = page.waitForResponse(response => response.url().includes("/chat/read") && response.status() === 429);
  await page.route("**/chat/read", async route => {
    if (new URLSearchParams(route.request().postData() ?? "").get("intent") === "read") { started = true; await gate; await route.fulfill({ status: 429, body: "Read receipt refused" }); }
    else await route.continue();
  });
  const context = await browser.newContext(); const writer = await context.newPage();
  try {
    await useMember(writer, "chat_next_readlive_writer@example.com", "/v/chat-next-readlive/chat"); await waitForClientRoute(writer);
    await writer.getByLabel(m.village_chat_body, { exact: true }).fill("A live arrival while reading the bottom");
    await writer.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByRole("log")).toContainText("A live arrival while reading the bottom");
    await expect.poll(async () => { await page.clock.runFor(250); return started; }).toBe(true);
    expect(await page.evaluate(() => (window as typeof window & { unreadFlashes: string[] }).unreadFlashes)).toEqual([]);
    release(); await failed;
    await expect(page.locator('[data-village-header] > nav .bg-unread')).toHaveCount(1);
  } finally { release(); await context.close(); }
});

test("continuing edited history to its end reconnects live receipts and mention notifications", async ({ page, browser }) => {
  await useMember(page, "chat_next_resync_reader@example.com", "/v/chat-next-resync/chat?before=56"); await waitForClientRoute(page);
  await expect(page.getByRole("log")).toContainText("Next resync message 55");
  const context = await browser.newContext(); const writer = await context.newPage();
  const unread = async () => (await (await page.request.get("/v/chat-next-resync/chat/changes?since=0")).json()).unread;
  let releaseHistory = () => {};
  try {
    await useMember(writer, "chat_next_resync_writer@example.com", "/v/chat-next-resync/chat?before=31"); await waitForClientRoute(writer);
    const id = await writer.locator("[data-chat-message]").filter({ hasText: "Next resync message 5" }).getAttribute("data-chat-message");
    const old = writer.locator(`[data-chat-message="${id}"]`);
    await old.hover(); await old.locator("summary").filter({ hasText: m.village_chat_edit }).click();
    await old.locator('textarea[name="body"]').fill("Edited history advances the event sequence");
    await old.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(old.locator("details").first()).not.toHaveAttribute("open", "");
    const polled = page.waitForResponse(response => response.url().includes("/chat/changes?") && new URL(response.url()).searchParams.get("after") === "55");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await (await polled).json()).next).toBeGreaterThan(60);
    await page.locator('a[href*="?after="]').scrollIntoViewIfNeeded();
    await expect(page.getByRole("log")).toContainText("Next resync message 60");
    await page.locator("[data-chat-message]").last().scrollIntoViewIfNeeded();
    await expect.poll(unread).toBe(0);
    await writer.getByLabel(m.village_chat_body, { exact: true }).fill("A live mention after edited history @chat_next_resync_reader");
    await writer.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.locator("[data-chat-message]").last()).toContainText("A live mention after edited history");
    await expect(page.locator("[data-chat-message]").last()).toBeInViewport();
    await expect.poll(unread).toBe(0);
    await expect.poll(async () => (await (await page.request.get("/navigation-header")).json()).unreadNotifications).toBe(0);
    await expect(page.locator("[data-village-header] > nav .bg-unread")).toHaveCount(0);
    await expect(page.locator('[data-site-navigation] a[href="/v/chat-next-resync/chat"] .bg-unread')).toHaveCount(0);
    await expect(page.locator('header a[href="/notifications"] [role="img"]')).toHaveCount(0);

    // A historical poll can consume a new event while the final page is in flight.
    let checkpoint: number | undefined;
    let continuationHasNewer: unknown;
    const gate = new Promise<void>(resolve => { releaseHistory = resolve; });
    await page.route("**/chat/changes?*forward=*", async route => {
      const response = await route.fetch();
      continuationHasNewer = (await response.json()).hasNewer;
      checkpoint = Number(new URL(route.request().url()).searchParams.get("since"));
      await gate; await route.fulfill({ response });
    });
    await page.goto("/v/chat-next-resync/chat?before=56"); await waitForClientRoute(page);
    await page.locator('a[href*="?after="]').click({ force: true });
    await expect.poll(() => checkpoint).toBeDefined();
    expect(continuationHasNewer).toBe(false);
    const skipped = page.waitForResponse(async response => response.url().includes("/chat/changes?") && new URL(response.url()).searchParams.get("after") === "55" && (await response.json()).next > checkpoint!);
    await writer.getByLabel(m.village_chat_body, { exact: true }).fill("An arrival during historical continuation @chat_next_resync_reader");
    await writer.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await skipped;
    await expect(page.getByRole("log")).not.toContainText("An arrival during historical continuation");
    releaseHistory();
    await expect(page.locator("[data-chat-message]").last()).toContainText("An arrival during historical continuation");
    await page.locator("[data-chat-message]").last().scrollIntoViewIfNeeded();
    await expect.poll(unread).toBe(0);
    await expect.poll(async () => (await (await page.request.get("/navigation-header")).json()).unreadNotifications).toBe(0);
  } finally { releaseHistory(); await context.close(); }
});

test("an unread opening bridges only own messages before the newest window", async ({ page }) => {
  await useMember(page, "chat_next_ownprefix_reader@example.com", "/v/chat-next-ownprefix/chat"); await waitForClientRoute(page);
  await expect(page.locator("[data-chat-message]").first()).toContainText("Next ownprefix message 12");
  await expect(page.getByRole("log")).not.toContainText("Next ownprefix message 11");
  await page.locator("[data-chat-message]").last().scrollIntoViewIfNeeded();
  await expect.poll(async () => (await (await page.request.get("/v/chat-next-ownprefix/chat/changes?since=0")).json()).unread).toBe(0);
  await expect(page.locator('[data-site-navigation] a[href="/v/chat-next-ownprefix/chat"] .bg-unread')).toHaveCount(0);
  await expect(page.locator("[data-village-header] > nav .bg-unread")).toHaveCount(0);
});
