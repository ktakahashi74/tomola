import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { enMessages as en } from "./helpers";

test("readiness identifies the build and maintenance rejects writes while pages stay readable", async ({ page, request }) => {
  const flag = path.join(path.dirname(process.env.E2E_STATE!), "maintenance");
  await page.goto("/login?lang=en");
  await expect(page.locator("footer [data-revision]")).toHaveText("0123456");
  const ready = await request.get("/readyz");
  expect(ready.status()).toBe(200);
  expect(ready.headers()["cache-control"]).toBe("no-store");
  expect(await ready.json()).toMatchObject({ database: "ok", revision: "0123456789abcdef0123456789abcdef01234567", worker: { enabled: true } });
  fs.writeFileSync(flag, "");
  try {
    await expect.poll(async () => (await request.post("/api/auth/sign-in/email", { data: {} })).status()).toBe(503);
    const auth = await request.post("/api/auth/sign-in/email", { data: {} });
    expect(auth.headers()["retry-after"]).toBe("30");
    expect(await auth.json()).toMatchObject({ error: "maintenance_readonly" });
    await page.goto("/login?lang=en");
    await page.locator('input[name="email"]').fill("maintenance@example.com");
    await page.locator('form button[type="submit"]').first().click();
    await expect(page.getByText(en.maintenance_readonly, { exact: true })).toBeVisible();
    expect((await request.get("/principles?lang=en")).status()).toBe(200);
    expect((await request.get("/readyz")).status()).toBe(200);
  } finally { fs.rmSync(flag, { force: true }); }
  await expect.poll(async () => (await request.post("/login", { form: {} })).status()).not.toBe(503);
});
