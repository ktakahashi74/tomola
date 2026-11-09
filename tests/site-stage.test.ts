import { expect, it } from "vitest";
import { testSiteEnabled } from "~/lib/site-stage.server";

it("enables test-site identification only for the explicit test stage", () => {
  for (const value of [undefined, "", "  "]) expect(testSiteEnabled({ TOMOLA_SITE_STAGE: value })).toBe(false);
  expect(testSiteEnabled({ TOMOLA_SITE_STAGE: "test" })).toBe(true);
  expect(testSiteEnabled({ TOMOLA_SITE_STAGE: " test " })).toBe(true);
  for (const value of ["1", "production", "tset"]) expect(() => testSiteEnabled({ TOMOLA_SITE_STAGE: value })).toThrow("TOMOLA_SITE_STAGE");
});
