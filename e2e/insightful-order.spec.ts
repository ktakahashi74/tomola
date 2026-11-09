import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, useMember, allListIds, clientHeaders, enMessages as m, state  } from "./helpers";

test("Insightful ordering matches for members and public readers and fits both list layouts", async ({ browser }) => {

  test.setTimeout(180_000);
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "insightful-order.json"), "utf8")) as { ids: number[]; invite: string };
  const member = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.235") });
  const guest = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.236") });
  try {
    const page = await member.newPage();
    const publicPage = await guest.newPage();
    await useMember(page, "insightful_order_reader@example.com");
    const directory = path.join(process.cwd(), ".data", "insightful-order", "screenshots");
    fs.mkdirSync(directory, { recursive: true });
    for (const url of ["/", "/a/ja"]) {
      await page.goto(url);
      const order = page.getByRole("navigation", { name: m.home_order_label, exact: true });
      await expect(order.getByRole("link")).toHaveCount(3);
      await order.getByRole("link", { name: m.home_order_insightful, exact: true }).click();
      await expect(page).toHaveURL(new RegExp("order=insightful"));
      await expect(order.getByRole("link", { name: m.home_order_insightful, exact: true })).toHaveAttribute("aria-current", "page");
      const rowIds = () => page.locator('li[id^="q-"]').evaluateAll(rows => rows.map(row => Number(row.id.slice(2))));
      const expected = [fixture.ids[0], fixture.ids[2], fixture.ids[1], fixture.ids[3]];
      if (url === "/") expected.unshift(fixture.ids[4]);
      const memberIds = await allListIds(page, `${url}?order=insightful`);
      expect(memberIds.filter(id => fixture.ids.includes(id))).toEqual(expected);
      await publicPage.goto(`${url}?order=insightful`);
      expect(await allListIds(publicPage, `${url}?order=insightful`)).toEqual(memberIds);
      await expect(publicPage.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", /order=insightful/);
      for (const [value, label] of [["created", m.home_order_created], ["activity", m.home_order_activity], ["insightful", m.home_order_insightful]]) {
        await order.getByRole("link", { name: label, exact: true }).click();
        await expect(order.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
        for (const width of [1366, 390]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await captureScreenshot(page, { path: path.join(directory, `${url === "/" ? "home" : "ja"}-${value}-${width}.png`), animations: "disabled" }, "e2e-insightful-order");
        }
      }
    }
  } finally { await member.close(); await guest.close(); }
});
