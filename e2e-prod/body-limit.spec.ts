import { request as playwrightRequest } from "@playwright/test";
import { test, expect, state } from "./helpers";

test("a request body over the limit is refused with 413 before the app reads it, and a normal one still goes through", async ({ request }) => {
  const big = await request.post("/preview", { data: Buffer.alloc(3 * 1024 * 1024, "a"), headers: { "Content-Type": "application/octet-stream" } });
  expect(big.status()).toBe(413);
  expect(await big.text()).toContain("Payload Too Large");
  // An in-limit body reaches the app: an unauthenticated request gets 302, 403 or similar, not 413.
  // The connection that carried the refused body is closed, so send this one on a fresh connection.
  const fresh = await playwrightRequest.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true });
  try {
    const small = await fresh.post("/preview", { data: "body=hello", headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 0 });
    expect(small.status()).not.toBe(413);
  } finally {
    await fresh.dispose();
  }
});
