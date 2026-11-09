import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { action } from "~/routes/login";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore());

// The harness replaces the mail sender when it signs a member in. If that sender recorded no delivery result, a login action called afterwards
// would answer "later" even for a registered address, and a test written against it would fail for the wrong reason.
it("after signIn, the login action answers 'sent' for a member's address", async () => {
  await h.signIn("harness-member", { email: "harness-member@example.com" });
  const request = h.request("/login", { form: { email: "harness-member@example.com", intent: "", next: "/" }, headers: { accept: "" } });
  const result = await h.outcome(() => action(h.args(request)));
  expect(result.value).toMatchObject({ data: { status: "sent" } });
});
