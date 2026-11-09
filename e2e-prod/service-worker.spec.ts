import { test, expect, state, waitForClientRoute, watchCsp } from "./helpers";

test("a build installs a fresh offline shell, removes the previous asset cache and enables navigation preload", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const watch = await watchCsp(page);
    await page.goto("/offline");
    await page.evaluate(async () => {
      const cache = await caches.open("tomola-shell-previous-build");
      await cache.put("/offline", new Response("Obsolete offline page"));
      await cache.put("/assets/obsolete.js", new Response("obsolete"));
    });
    await page.goto("/login"); await waitForClientRoute(page);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${state().baseURL}/sw.js`);
    const shell = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names[0]);
      const registration = await navigator.serviceWorker.ready;
      return { names, offline: await (await cache.match("/offline"))?.text(), obsolete: !!await cache.match("/assets/obsolete.js"), preload: await registration.navigationPreload.getState() };
    });
    expect(shell.names).toHaveLength(1);
    expect(shell.names[0]).toMatch(/^tomola-shell-[a-f0-9-]{36}$/);
    expect(shell.offline).toContain("<!doctype html>");
    expect(shell.offline).not.toContain("Obsolete offline page");
    expect(shell.obsolete).toBe(false);
    expect(shell.preload.enabled).toBe(true);
    const worker = await (await page.request.get("/sw.js")).text();
    expect(worker).toContain(`const CACHE = "${shell.names[0]}"`);
    expect(worker).not.toContain("__TOMOLA_BUILD_ID__");
    expect(watch.violations).toEqual([]); expect(watch.pageErrors).toEqual([]);
  } finally { await context.close(); }
});
