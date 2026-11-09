import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { LANG_LABELS, LANGS, type Lang } from "../app/lib/languages";
import { captureScreenshot, useMember, visitListRow, clientHeaders, enMessages as en, formatMessage, state, uiMessages, waitForClientRoute } from "./helpers";

type Topic = { id: number; lang: Lang; title: string; body: string };
type Fixture = { topics: Topic[]; invitations: { email: string; url: string }[] };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "read-lang.json"), "utf8"));
// The reading language is one small control (a details): the name of the language now read and a chevron. Its list holds the links that carry hreflang.
function menu(page: Page) { return page.locator("details.reading-lang-menu").first(); }
async function openMenu(page: Page) { const control = menu(page); await control.locator("summary").click(); return control; }
async function chooseReading(page: Page, name: string) { await (await openMenu(page)).getByRole("link", { name, exact: true }).click(); }
const row = (page: Page, topic: Topic) => page.locator(`#q-${topic.id}`);
const title = (topic: Topic, target: Lang) => topic.lang === target ? topic.title : `[${target}] ${topic.title}`;
async function registerReader(page: Page, invitation: Fixture["invitations"][number], _handle: string) {
  await useMember(page, invitation.email);
}

async function assertTitles(page: Page, topics: Topic[], target?: Lang) {
  const url = page.url();
  for (const topic of topics) {
    await visitListRow(page, url, row(page, topic));
    await expect(row(page, topic).locator(".topic-title")).toHaveText(target ? title(topic, target) : topic.lang === "fr" ? title(topic, "en") : topic.title);
  }
  await page.goto(url);
}
async function listIds(page: Page) { return page.locator(".topic-row").evaluateAll(rows => rows.map(row => row.id)); }
async function evidence(page: Page, name: string) {
  const directory = path.join(process.cwd(), ".data/read-lang-switch/screenshots");
  fs.mkdirSync(directory, { recursive: true });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: path.join(directory, `${name}-${width}.png`), animations: "disabled" }, "e2e-read-lang-switch");
  }
}

test.describe("page reading language", () => {


  test("member switches list and article languages without changing preferences, membership or filters", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.241") });
    try {
      await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
      const page = await context.newPage();
      const { topics, invitations } = fixture();
      await registerReader(page, invitations[0], "read_lang_member");
      const localeBefore = (await context.cookies()).filter(c => c.name === "PARAGLIDE_LOCALE");
      await assertTitles(page, topics);
      const usualIds = await listIds(page);
      // Closed: only the name of the language now read (no label); the languages are inside.
      await expect(menu(page).locator("summary")).toHaveText(LANG_LABELS.en);
      await expect(menu(page).locator("summary")).toHaveAttribute("aria-label", `${en.reading_lang_label}: ${LANG_LABELS.en}`);
      await expect(page.getByText(en.reading_lang_label, { exact: true })).toHaveCount(0);
      const nav = (await openMenu(page)).getByRole("navigation", { name: en.reading_lang_label, exact: true });
      await expect(nav.locator("a")).toHaveCount(LANGS.length);
      await expect(nav.locator("[aria-current=page]")).toHaveText(LANG_LABELS.en);
      for (const link of await nav.locator("a").all()) {
        const lang = await link.getAttribute("lang");
        expect(LANGS).toContain(lang);
        await expect(link).toHaveAttribute("hreflang", lang!);
      }
      await evidence(page, "home-usual");
      await nav.getByRole("link", { name: LANG_LABELS.fr, exact: true }).click();
      // The mark (rl) says that the address came from this choice: the screen keeps its own language.
      await expect(page).toHaveURL(new URL("/?lang=fr&rl=1", state().baseURL).href);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await assertTitles(page, topics, "fr");
      expect(await listIds(page)).toEqual(usualIds);
      await evidence(page, "home-chosen");

      await page.goto("/?order=activity&long=1");
      const filteredIds = await listIds(page);
      await page.goto("/?order=activity&long=1&page=2");
      await chooseReading(page, LANG_LABELS.fr);
      await expect(page).toHaveURL(url => url.searchParams.get("lang") === "fr" && !url.searchParams.has("page"));
      expect(new URL(page.url()).searchParams.get("page")).toBeNull();
      expect(new URL(page.url()).searchParams.get("order")).toBe("activity");
      expect(new URL(page.url()).searchParams.get("long")).toBe("1");
      await expect.poll(() => listIds(page)).toEqual(filteredIds);
      await page.getByRole("navigation", { name: en.home_order_label, exact: true }).getByRole("link", { name: en.home_order_insightful, exact: true }).click();
      await expect(page).toHaveURL(url => url.searchParams.get("lang") === "fr" && url.searchParams.get("order") === "insightful");
      await waitForClientRoute(page);
      await page.locator(`summary[aria-label^="${en.filter_prefix}"]`).click();
      await page.getByRole("navigation", { name: en.list_filter_label, exact: true }).getByRole("link", { name: en.home_filter_all, exact: true }).click();
      await expect(page).toHaveURL(url => !url.searchParams.has("long") && url.searchParams.get("order") === "insightful");
      expect(new URL(page.url()).searchParams.get("lang")).toBe("fr");
      expect(new URL(page.url()).searchParams.get("order")).toBe("insightful");

      const japanese = topics.find(t => t.lang === "ja")!;
      await visitListRow(page, page.url(), row(page, japanese));
      await row(page, japanese).locator(".topic-title").click();
      // The thread link carries the mark too, so the screen keeps its language on the next page.
      await expect(page).toHaveURL(new URL(`/t/${japanese.id}?lang=fr&rl=1`, state().baseURL).href);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "fr"));
      await expect(page.locator("[data-reading-body]")).toContainText(`[fr] ${japanese.body.split("\n")[0]}`);
      // On an article the control is in the byline and says what is read (the translation); the original language is marked in its list.
      await expect(page.locator("[data-reading-language]")).toContainText(formatMessage(en.label_from_lang_machine_engine, { lang: en.language_name_ja, engine: en.engine_fake }));
      await expect((await openMenu(page)).getByRole("link", { name: formatMessage(en.reading_lang_original, { name: LANG_LABELS.ja }), exact: true })).toBeVisible();
      // Escape closes the list and returns focus to the name; a press outside it closes it too.
      await page.keyboard.press("Escape");
      await expect(menu(page)).not.toHaveAttribute("open");
      await expect(menu(page).locator("summary")).toBeFocused();
      await openMenu(page);
      await page.getByRole("heading", { level: 1 }).click();
      await expect(menu(page)).not.toHaveAttribute("open");
      await evidence(page, "topic-chosen");
      await page.getByRole("link", { name: en.show_original, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(japanese.title);
      await chooseReading(page, LANG_LABELS.en);
      await expect(page).toHaveURL(new URL(`/t/${japanese.id}?lang=en&rl=1`, state().baseURL).href);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "en"));
      await chooseReading(page, LANG_LABELS.fr);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "fr"));
      const french = topics.find(t => t.lang === "fr")!;
      await page.goto(`/t/${french.id}?lang=fr`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(french.title);

      await page.goto("/a/ja?order=created&long=1");
      const areaIds = await listIds(page);
      await chooseReading(page, LANG_LABELS.fr);
      await expect(page).toHaveURL(url => url.pathname === "/a/ja" && url.searchParams.get("lang") === "fr");
      expect(await listIds(page)).toEqual(areaIds);
      expect(new URL(page.url()).searchParams.get("order")).toBe("created");
      expect(new URL(page.url()).searchParams.get("long")).toBe("1");
      const areaUrl = page.url();
      await visitListRow(page, areaUrl, row(page, japanese));
      await expect(row(page, japanese).locator(".topic-title")).toHaveText(title(japanese, "fr"));
      await page.goto(areaUrl);
      await page.goto("/following?lang=fr");
      await expect(menu(page)).toHaveCount(0);
      expect((await context.cookies()).filter(c => c.name === "PARAGLIDE_LOCALE")).toEqual(localeBefore);
      await page.goto("/settings");
      const group = page.getByRole("group", { name: en.onboarding_read_langs });
      for (const lang of ["ja", "en"] as const) await expect(group.getByRole("checkbox", { name: LANG_LABELS[lang], exact: true })).toBeChecked();
    } finally { await context.close(); }
  });

  test("ordinary links switch and restore the usual language without JavaScript", async ({ browser }) => {
    test.setTimeout(120_000);
    const setup = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.242") });
    let storageState;
    const { topics, invitations } = fixture();
    try {
      await registerReader(await setup.newPage(), invitations[1], "read_lang_nojs");
      storageState = await setup.storageState();
    } finally { await setup.close(); }
    const context = await browser.newContext({ storageState, javaScriptEnabled: false, locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.243") });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await chooseReading(page, LANG_LABELS.fr);
      await assertTitles(page, topics, "fr");
      const japanese = topics.find(t => t.lang === "ja")!;
      await visitListRow(page, page.url(), row(page, japanese));
      await row(page, japanese).locator(".topic-title").click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "fr"));
      await chooseReading(page, LANG_LABELS.en);
      await expect(page).toHaveURL(new URL(`/t/${japanese.id}?lang=en&rl=1`, state().baseURL).href);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "en"));
    } finally { await context.close(); }
  });

  test("public readers switch screen and post languages together while articles keep their reading menu", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.244") });
    try {
      const page = await context.newPage();
      const { topics } = fixture();
      // A shared link still sets the screen language without persisting a preference.
      await page.goto("/?lang=fr");
      await expect(page.locator("html")).toHaveAttribute("lang", "fr");
      expect((await context.cookies()).filter(c => c.name === "PARAGLIDE_LOCALE")).toEqual([]);
      const chooseScreen = async (lang: Lang) => {
        await waitForClientRoute(page);
        await page.locator("header").getByRole("combobox", { name: (await uiMessages(page)).language_select, exact: true }).click();
        await page.getByRole("listbox").getByRole("option", { name: LANG_LABELS[lang], exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("lang", lang);
      };
      for (const pathname of ["/", "/a/ja", "/v/ja"]) {
        await page.goto(`${pathname}?lang=fr&rl=fr&order=activity&page=2&long=1#posts`);
        await expect(menu(page)).toHaveCount(0);
        await expect(page.locator("header").getByRole("combobox", { name: (await uiMessages(page)).language_select, exact: true })).toHaveCount(1);
        // The guest's language choice clears the reading override and its mark, including on paginated lists.
        await chooseScreen("ja");
        await expect(page).toHaveURL(url => url.pathname === pathname && !url.searchParams.has("lang") && url.searchParams.get("order") === "activity"
          && url.searchParams.get("page") === "2" && url.searchParams.get("long") === "1" && !url.searchParams.has("rl") && url.hash === "#posts");
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await chooseScreen("en");
      }
      await page.goto("/?lang=fr");
      await chooseScreen("ja");
      await assertTitles(page, topics, "ja");
      await chooseScreen("en");
      await assertTitles(page, topics, "en");
      const japanese = topics.find(t => t.lang === "ja")!;
      const chooseArticle = async (lang: Lang) => {
        await waitForClientRoute(page);
        const name = lang === japanese.lang ? formatMessage((await uiMessages(page)).reading_lang_original, { name: LANG_LABELS[lang] }) : LANG_LABELS[lang];
        await chooseReading(page, name);
      };
      await page.goto(`/t/${japanese.id}?lang=fr`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "fr"));
      await expect(menu(page)).toHaveCount(1);
      await chooseArticle("en");
      await expect(page).toHaveURL(new URL(`/t/${japanese.id}?lang=en&rl=1`, state().baseURL).href);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(japanese, "en"));
      await chooseArticle("ja");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(japanese.title);
      // Without a cookie, an article's reading choice still pins the shared link's screen language.
      await context.clearCookies({ name: "PARAGLIDE_LOCALE" });
      await page.goto(`/t/${japanese.id}?lang=fr`);
      await expect(page.locator("html")).toHaveAttribute("lang", "fr");
      for (const lang of ["ja", "en", "fr"] as const) {
        await chooseArticle(lang);
        await expect(page).toHaveURL(url => url.searchParams.get("lang") !== null && url.searchParams.get("rl") === "fr");
        await expect(page.locator("html")).toHaveAttribute("lang", "fr");
      }
      const french = topics.find(topic => topic.lang === "fr")!;
      await chooseScreen("ja");
      await page.goto(`/t/${french.id}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(french, "ja"));
      await (await openMenu(page)).locator('a[hreflang="fr"]').click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(french.title);
      await expect(page).toHaveURL(url => url.searchParams.get("lang") === "fr" && ["orig", "tr", "old"].every(key => !url.searchParams.has(key)));
      await chooseScreen("en");
      await expect(page).toHaveURL(new RegExp(`/t/${french.id}(?:\\?sl=[\\w-]+)?$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title(french, "en"));
    } finally { await context.close(); }
  });
});
