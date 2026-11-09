import { expect, type Page } from "@playwright/test";
import { LANG_LABELS } from "../../app/lib/languages";
import { uiMessages, waitForHydration } from "../helpers";

export type TranslationCase = {
  title: string;
  accept: string | null;
  lang: string;
  suppress: boolean;
  query?: string;
  cookie?: string;
  path?: string;
};

export const translationCases: TranslationCase[] = [
  { title: "regional first language", accept: "ja-JP,en;q=0.8", lang: "ja", suppress: true },
  { title: "highest q wins over written order", accept: "en;q=0.5,ja;q=0.9", lang: "ja", suppress: true },
  { title: "unavailable first language with an enabled second choice", accept: "sv-SE,en;q=0.8", lang: "en", suppress: false },
  { title: "unavailable first language with the default", accept: "sv-SE", lang: "en", suppress: false },
  { title: "query selects another language", accept: "ja-JP", query: "?lang=en", lang: "en", suppress: false },
  { title: "query matches the first language", accept: "ja-JP", query: "?lang=ja", lang: "ja", suppress: true },
  { title: "reading-only query preserves the screen", accept: "ja-JP", query: "?lang=en&rl=1", lang: "ja", suppress: true },
  { title: "reading pin selects another screen language", accept: "ja-JP", query: "?lang=ja&rl=en", lang: "en", suppress: false },
  { title: "cookie overrides both query and browser", accept: "en-US", query: "?lang=en", cookie: "ja", lang: "ja", suppress: true },
  { title: "cookie without a browser preference", accept: null, cookie: "ja", lang: "ja", suppress: true },
  { title: "missing browser preference", accept: null, lang: "en", suppress: false },
  { title: "query without a browser preference", accept: null, query: "?lang=ja", lang: "ja", suppress: false },
  { title: "early error with a supported preference", accept: "en-US", path: "/missing-browser-translation-page", lang: "en", suppress: true },
  { title: "early error with an unsupported preference", accept: "sv-SE", path: "/missing-browser-translation-page", lang: "en", suppress: false },
];

export function watchHydration(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type()) && /hydrat|did not match|Minified React error|react\.dev\/errors/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

export async function expectTranslationMarks(page: Page, lang: string, suppress: boolean, html?: string) {
  const marks = await page.evaluate(source => {
    const doc = source === undefined ? document : new DOMParser().parseFromString(source, "text/html");
    return {
      lang: doc.documentElement.lang,
      translate: doc.documentElement.getAttribute("translate"),
      google: Array.from(doc.head.querySelectorAll('meta[name="google"]'), meta => meta.getAttribute("content")),
    };
  }, html);
  expect(marks).toEqual({ lang, translate: suppress ? "no" : null, google: suppress ? ["notranslate"] : [] });
}

async function setBrowserLanguage(page: Page, accept: string | null) {
  // Deliberately keep navigator.language different from several request headers. Only the server decides.
  await page.route("**/*", async route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    const headers = { ...route.request().headers() };
    delete headers["accept-language"];
    if (accept !== null) headers["accept-language"] = accept;
    await route.continue({ headers });
  });
}

export async function exerciseTranslationCase(page: Page, baseURL: string, scenario: TranslationCase) {
  const errors = watchHydration(page);
  await setBrowserLanguage(page, scenario.accept);
  if (scenario.cookie) await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: scenario.cookie, url: baseURL }]);
  const response = await page.goto(`${scenario.path ?? "/login"}${scenario.query ?? ""}`);
  expect(response!.status()).toBe(scenario.path ? 404 : 200);
  await expectTranslationMarks(page, scenario.lang, scenario.suppress, await response!.text());
  await waitForHydration(page);
  await expectTranslationMarks(page, scenario.lang, scenario.suppress);
  expect(errors).toEqual([]);
}

export async function exerciseTranslationChoice(page: Page) {
  const errors = watchHydration(page);
  await setBrowserLanguage(page, "sv-SE,en;q=0.8");
  await page.goto("/login");
  await waitForHydration(page);
  await expectTranslationMarks(page, "en", false);
  const messages = await uiMessages(page);
  await page.getByRole("combobox", { name: messages.language_select, exact: true }).click();
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.getByRole("option", { name: LANG_LABELS.ja, exact: true }).click();
  await reloaded;
  await waitForHydration(page);
  await expectTranslationMarks(page, "ja", true);
  expect((await page.context().cookies()).find(cookie => cookie.name === "PARAGLIDE_LOCALE")?.value).toBe("ja");
  // The context retains the document's decision during client navigation, even when root data revalidates.
  await page.evaluate(() => { (window as unknown as { translationDocument: boolean }).translationDocument = true; });
  await page.getByRole("contentinfo").locator('a[href="/privacy"]').click();
  await expect(page).toHaveURL(/\/privacy(?:\?|$)/);
  await waitForHydration(page);
  expect(await page.evaluate(() => (window as unknown as { translationDocument?: boolean }).translationDocument)).toBe(true);
  await expectTranslationMarks(page, "ja", true);
  const response = await page.reload();
  await expectTranslationMarks(page, "ja", true, await response!.text());
  await waitForHydration(page);
  await expectTranslationMarks(page, "ja", true);
  expect(errors).toEqual([]);
}
