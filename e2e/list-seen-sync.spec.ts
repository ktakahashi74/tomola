import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as m, titleField, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

const isExchange = (url: string) => new URL(url).pathname === "/list-seen";
const dot = (page: Page, id: string) => page.locator(`#q-${id}`).getByText(m.list_new_post, { exact: true });

async function publish(page: Page, text: string) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: titleField(page) }));
  await titleField(page).fill(text);
  await page.getByLabel(m.field_body, { exact: true }).fill(text);
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:[?#].*)?$/);
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function memberVisit(page: Page) {
  const response = page.waitForResponse(response => isExchange(response.url()) && response.request().method() === "POST");
  await page.goto("/?lang=en");
  await waitForClientRoute(page);
  const exchanged = await response;
  expect(exchanged.status()).toBe(200);
  return exchanged;
}

test("account list boundaries follow the member across independent browser storage", async ({ browser, page: writer }) => {
  await useMember(writer, "zseen_sync_writer@example.com", "/t/new");
  const anchor = await publish(writer, "Account boundary anchor");
  const a = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.93.0.1") });
  const b = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.93.0.2") });
  try {
    const first = await a.newPage();
    const second = await b.newPage();
    await useMember(first, "zseen_sync_reader@example.com", `/t/${anchor}?lang=en`);
    await useMember(second, "zseen_sync_reader@example.com", `/t/${anchor}?lang=en`);
    expect(await (await memberVisit(first)).json()).toEqual({ previous: null });
    await memberVisit(second);
    await second.evaluate(() => localStorage.setItem("tomola.seen-posts", JSON.stringify([["/", "2020-01-01T00:00:00.000Z"]])));
    const added = await publish(writer, "Account boundary newly published post");
    expect((await second.request.get("/?lang=en", { headers: { Purpose: "prefetch" } })).status()).toBe(200);
    expect((await second.request.get("/?lang=en")).status()).toBe(200);
    const advanced = await memberVisit(first);
    await expect(dot(first, added)).toBeVisible();
    await expect(first.locator("[data-seen-boundary]")).toBeVisible();
    const newest = advanced.request().postDataJSON().seenAt;
    let revalidatedExchanges = 0;
    first.on("request", request => { if (isExchange(request.url())) revalidatedExchanges++; });
    await first.evaluate(async () => {
      const router = (window as unknown as { __reactRouterDataRouter: { revalidate(): Promise<void> } }).__reactRouterDataRouter;
      await router.revalidate();
    });
    await waitForClientRoute(first);
    await expect(dot(first, added)).toBeVisible();
    expect(revalidatedExchanges).toBe(0);
    const otherDevice = await memberVisit(second);
    expect(await otherDevice.json()).toEqual({ previous: newest });
    await expect(second.locator(`#q-${added}`)).toBeVisible();
    await expect(dot(second, added)).toHaveCount(0);
    await expect(second.locator("[data-seen-boundary]")).toHaveCount(0);
    await memberVisit(first);
    await expect(dot(first, added)).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});

test("a failed account exchange leaves the list usable without browser fallback", async ({ page }) => {
  await useMember(page, "zseen_failure_writer@example.com", "/t/new");
  const owned = await publish(page, "Failed boundary synchronization post");
  await useMember(page, "zseen_failure_reader@example.com", `/t/${owned}?lang=en`);
  await page.evaluate(() => localStorage.setItem("tomola.seen-posts", JSON.stringify([["/", "2020-01-01T00:00:00.000Z"]])));
  let attempts = 0;
  await page.route("**/list-seen", route => { attempts++; return route.abort(); });
  await page.goto("/?lang=en");
  await waitForClientRoute(page);
  await expect.poll(() => attempts).toBe(1);
  await expect(page.locator(`#q-${owned}`)).toBeVisible();
  await expect(page.getByText(m.list_new_post, { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-seen-boundary]")).toHaveCount(0);
  await page.locator(`#q-${owned} .topic-title`).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:[?#].*)?$/);
});

test("signed-out boundaries remain independent between browsers", async ({ browser, page: writer }) => {
  await useMember(writer, "zseen_guest_writer@example.com", "/t/new");
  await publish(writer, "Guest boundary anchor");
  const a = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.93.0.3") });
  const b = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.93.0.4") });
  try {
    const first = await a.newPage();
    const second = await b.newPage();
    const exchanges: string[] = [];
    for (const page of [first, second]) {
      page.on("request", request => { if (isExchange(request.url())) exchanges.push(request.method()); });
      await page.goto("/?lang=en");
      await waitForClientRoute(page);
      await expect.poll(() => page.evaluate(() => localStorage.getItem("tomola.seen-posts"))).not.toBeNull();
      await expect(page.getByText(m.list_new_post, { exact: true })).toHaveCount(0);
    }
    const added = await publish(writer, "Guest boundary newly published post");
    await first.goto("/?lang=en");
    await expect(dot(first, added)).toBeVisible();
    await first.reload();
    await waitForClientRoute(first);
    await expect(dot(first, added)).toHaveCount(0);
    await second.goto("/?lang=en");
    await expect(dot(second, added)).toBeVisible();
    await expect(second.locator("[data-seen-boundary]")).toBeVisible();
    expect(exchanges).toEqual([]);
  } finally { await a.close(); await b.close(); }
});
