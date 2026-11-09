import { saveEditorDraft } from "./draft-autosave-helper";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { formatTime } from "../app/lib/time-format";
import { useMember, clientHeaders, jaMessages as ja, state, openPostSettings } from "./helpers";

test("390px pages stay within the viewport and timestamps hydrate to Tokyo time", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", extraHTTPHeaders: clientHeaders("10.18.0.1") });
  const page = await context.newPage();
  const hydrationErrors: string[] = [];
  page.on("console", message => { if (/hydration|hydrated|did not match|server rendered HTML|Minified React error #418/i.test(message.text())) hydrationErrors.push(message.text()); });
  page.on("pageerror", error => hydrationErrors.push(error.message));
  const withinViewport = async (label: string, target: Page = page) => {
    await expect(target.locator("main")).toBeVisible();
    await target.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect.poll(async () => {
      try { return await target.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); }
      catch (error) {
        // Vite can reload after discovering a route's dependencies; measure the final document.
        if (error instanceof Error && error.message.includes("Execution context was destroyed")) return Infinity;
        throw error;
      }
    }, { message: `${label} horizontal overflow` }).toBeLessThanOrEqual(0);
  };
  // The one rule of app/lib/time-format.ts, applied to the reader's zone (Tokyo) and to the server's fallback (UTC, with the zone named).
  const localTimestamp = async (time: Locator, style: "short" | "stamp" | "date" = "short") => {
    const iso = await time.getAttribute("datetime");
    expect(iso).toBeTruthy();
    const shown = formatTime(iso!, { now: new Date(), timeZone: "Asia/Tokyo", locale: "ja", style });
    await expect(time).toHaveText(shown.text);
    await expect(time).toHaveAttribute("title", shown.full);
    return iso!;
  };
  try {
    await useMember(page, "mobile@example.com");
    await localTimestamp(page.locator("li[id^=q-] time[datetime]").first());
    await expect(page.locator("textarea")).toHaveCount(0);
    await withinViewport("home rows");
    await page.goto("/t/new");
    await withinViewport("new topic");
    await openPostSettings(page);
    await expect(page.getByRole("combobox", { name: ja.field_lang, exact: true }).locator('[data-slot="select-value"]')).toHaveText(ja.field_lang_auto);
    await page.getByRole("textbox", { name: ja.field_title, exact: true }).fill("狭い画面の確認");
    await page.getByRole("textbox", { name: ja.field_body, exact: true }).fill("現地時刻と画面の幅を確かめる新しい投稿。");
    await page.getByRole("button", { name: ja.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    const topicPath = new URL(page.url()).pathname;
    const topicId = topicPath.split("/").at(-1);
    await withinViewport("topic and reply composer");
    const iso = await localTimestamp(page.locator(`#p-${topicId} time[datetime]`).first(), "date");

    const plain = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", javaScriptEnabled: false, storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("10.18.0.2") });
    try {
      const noJs = await plain.newPage();
      await noJs.goto(`${state().baseURL}${topicPath}`);
      const time = noJs.locator(`#p-${topicId} time[datetime]`).first();
      await expect(time).toHaveText(formatTime(iso, { now: new Date(), timeZone: "UTC", locale: "ja", style: "date", zoneLabel: true }).text);
      await expect(time).toHaveAttribute("datetime", iso);
      await withinViewport("no-JavaScript topic", noJs);
    } finally { await plain.close(); }

    await page.goto("/t/new");
    await page.getByRole("textbox", { name: ja.field_title, exact: true }).fill("狭い画面の下書き");
    await page.getByRole("textbox", { name: ja.field_body, exact: true }).fill("下書きの選択欄も画面に収まる。");
    await saveEditorDraft(page);
    await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
    await withinViewport("draft composer");
    for (const [path, title] of [["/admin/metrics", ja.metrics_title], ["/admin/observation", ja.observation_title], ["/admin/roles?q=mobile_ui", ja.admin_roles_title]]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await withinViewport(path);
    }
    expect(hydrationErrors).toEqual([]);
  } finally { await context.close(); }
});
