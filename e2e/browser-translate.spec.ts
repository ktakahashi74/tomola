import { test } from "./editor-fixture";
import { exerciseTranslationCase, exerciseTranslationChoice, translationCases, type TranslationCase } from "./support/browser-translation";

const chineseCases: TranslationCase[] = [
  { title: "Traditional Chinese region", accept: "zh-TW", lang: "zh-Hant", suppress: true },
  { title: "Simplified Chinese region", accept: "zh-CN", lang: "zh-Hans", suppress: true },
  { title: "Traditional Chinese script", accept: "zh-Hant-HK", lang: "zh-Hant", suppress: true },
  { title: "another Chinese script in a shared link", accept: "zh-CN", query: "?lang=zh-Hant", lang: "zh-Hant", suppress: false },
];

for (const scenario of [...translationCases, ...chineseCases]) {
  test(`browser translation marks: ${scenario.title}`, async ({ page, baseURL }) => {
    await exerciseTranslationCase(page, baseURL!, scenario);
  });
}

test("explicit screen choice suppresses browser translation across hydration and navigation", async ({ page }) => {
  await exerciseTranslationChoice(page);
});
