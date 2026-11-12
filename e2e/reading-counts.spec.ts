import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { state, waitForClientRoute } from "./helpers";

const fixtures = () => JSON.parse(fs.readFileSync(path.join(state().dir, "reading-counts.json"), "utf8")) as number[];

test("anonymous original and translated displays report once, and client navigation is internal", async ({ page }) => {
  const [first, next] = fixtures();
  const reads: Array<{ internal: boolean; referrerHost?: string }> = [];
  const responses: number[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/translations") && request.postDataJSON()?.intent === "read") reads.push(request.postDataJSON()); });
  page.on("response", response => { const request = response.request(); if (request.method() === "POST" && request.url().includes("/translations") && request.postDataJSON()?.intent === "read") responses.push(response.status()); });
  await page.goto(`/t/${first}?lang=ja&sl=ja`);
  await expect.poll(() => responses.length).toBe(1);
  expect(reads).toEqual([{ intent: "read", ids: [], internal: false, shared: true, referrerHost: "" }]);
  await waitForClientRoute(page);
  await page.evaluate(async id => {
    await (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(`/t/${id}?lang=en&sl=en`);
  }, next);
  await expect(page.locator(`#p-${next} .longread`)).toHaveAttribute("lang", "en");
  await expect.poll(() => responses.length).toBe(2);
  expect(reads[1].internal).toBe(true);
  await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { revalidate(): void } }).__reactRouterDataRouter.revalidate());
  await waitForClientRoute(page);
  expect(responses).toEqual([200, 200]);
  expect(reads).toHaveLength(2);
  await page.evaluate(() => { location.hash = "reply"; });
  await waitForClientRoute(page);
  expect(reads).toHaveLength(2);
});

test("hidden documents wait for visibility and prefetched HTML never reports a browser read", async ({ page }) => {
  const [, , hidden] = fixtures();
  const reads: unknown[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/translations") && request.postDataJSON()?.intent === "read") reads.push(request.postDataJSON()); });
  await page.goto("/?lang=en");
  await waitForClientRoute(page);
  expect(await page.evaluate(async id => (await fetch(`/t/${id}?lang=en`, { headers: { Purpose: "prefetch" } })).status, hidden)).toBe(200);
  expect(reads).toHaveLength(0);
  await page.goto(`/t/${hidden}?lang=en`);
  await waitForClientRoute(page);
  expect(reads).toHaveLength(0);
  const report = page.waitForResponse(response => response.request().method() === "POST" && response.request().postDataJSON()?.intent === "read");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect((await report).status()).toBe(200);
  expect(reads).toHaveLength(1);
});

test("the first article after entering on a list is internal even before another article has been read", async ({ page }) => {
  const [, , , id] = fixtures();
  await page.goto("/?lang=en");
  await waitForClientRoute(page);
  const reads: Array<{ internal: boolean; referrerHost: string }> = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/translations") && request.postDataJSON()?.intent === "read") reads.push(request.postDataJSON()); });
  const report = page.waitForResponse(response => response.request().method() === "POST" && response.request().postDataJSON()?.intent === "read");
  await page.evaluate(async topicId => {
    await (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(`/t/${topicId}?lang=en&sl=en`);
  }, id);
  expect((await report).status()).toBe(200);
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ internal: true, referrerHost: "" });
});
