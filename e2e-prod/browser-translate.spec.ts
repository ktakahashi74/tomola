import { test } from "./helpers";
import { exerciseTranslationCase, exerciseTranslationChoice, translationCases } from "../e2e/support/browser-translation";

for (const scenario of [...translationCases, { title: "disabled Chinese script", accept: "zh-TW,en;q=0.8", lang: "en", suppress: false }]) {
  test(`production browser translation marks: ${scenario.title}`, async ({ page, baseURL }) => {
    await exerciseTranslationCase(page, baseURL!, scenario);
  });
}

test("production screen choice suppresses browser translation across hydration and navigation", async ({ page }) => {
  await exerciseTranslationChoice(page);
});
