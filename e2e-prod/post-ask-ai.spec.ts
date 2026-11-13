import { enMessages as en } from "../e2e/helpers";
import { postAskFlow } from "../e2e/post-ask-ai-flow";
import { test, expect, useMember, state, watchCsp } from "./helpers";

test("private post questions work through the production draft and reply flow", async ({ page }) => {
  test.setTimeout(240_000);
  const watch = await watchCsp(page);
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await useMember(page, "zask_prod@example.com");
  await postAskFlow(page, { logFile: state().serverLog });
  expect(watch.violations).toEqual([]);
  expect(watch.pageErrors).toEqual([]);
  expect(watch.hydrationWarnings).toEqual([]);
  await expect(page.getByRole("link", { name: en.post_ask_entry, exact: true })).toBeVisible();
});
