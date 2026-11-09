import { expect, useMember, test, watchCsp } from "./helpers";
import { exercisePrehydration } from "../e2e/support/prehydration";

// Cached service-worker responses bypass page.route and would hydrate while scripts are held.
test.use({ serviceWorkers: "block" });

test("early input survives the production SSR hydration under CSP", async ({ page }, info) => {
  const watch = await watchCsp(page);
  await useMember(page, "kai@example.com");
  await exercisePrehydration(page, info);
  expect(watch.violations).toEqual([]);
  expect(watch.hydrationWarnings).toEqual([]);
  expect(watch.pageErrors).toEqual([]);
});
