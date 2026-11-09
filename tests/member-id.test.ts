import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { profiles } from "~/lib/db/schema";
import { changeHandle } from "~/lib/profiles.server";
import { loader } from "~/routes/member-id";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); });
afterAll(() => h.restore());
it("requires membership and never uses an authentication user id as a public destination", async () => {
  const [person] = await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana));
  expect(person.publicId).toMatch(/^[a-z0-9]{12}$/);
  expect(person.publicId).not.toBe(h.ids.hana);
  expect(await h.outcome(async () => (await loader(h.args(h.request(`/u/id/${person.publicId}`), { publicId: person.publicId }))))).toMatchObject({ status: 302, location: expect.stringContaining("/login") });
  expect(await h.outcome(async () => (await loader(h.args(h.request(`/u/id/${h.ids.hana}`, { as: "hana" }), { publicId: h.ids.hana }))))).toMatchObject({ status: 404 });
});
it("redirects a stable identifier to the current username with private cache policy", async () => {
  const [person] = await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana));
  await changeHandle(h.db, h.ids.hana, "hanna");
  try { await loader(h.args(h.request(`/u/id/${person.publicId}`, { as: "hana" }), { publicId: person.publicId })); throw new Error("expected redirect"); }
  catch (response) {
    expect(response).toBeInstanceOf(Response);
    const r = response as Response;
    expect(r.status).toBe(302); expect(r.headers.get("Location")).toBe("/u/hanna");
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
  }
});
