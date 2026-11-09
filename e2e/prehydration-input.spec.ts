import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, clientHeaders } from "./helpers";
import { exercisePrehydration } from "./support/prehydration";

test("input typed before client scripts survives hydration, rerenders and publication", async ({ browser }, info) => {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.55.1") });
  const page = await context.newPage();
  try {
    await useMember(page, "earlywriter@example.com");
    await exercisePrehydration(page, info);
  } finally { await context.close().catch(() => undefined); }
});
