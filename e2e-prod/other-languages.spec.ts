import { test, useMember, state } from "./helpers";
import { writeOtherLanguageReply } from "../e2e/other-languages-flow";

test("unopened language replies work in the production build", async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await useMember(page, "scribe_other_prod@example.com");
  await writeOtherLanguageReply(page, "en");
});
