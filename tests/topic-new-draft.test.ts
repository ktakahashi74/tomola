import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { drafts, profiles } from "~/lib/db/schema";
import { DRAFT_RATE_LIMIT, MEMBER_RATE_LIMITS, hitMemberLimit, hitRateLimit } from "~/lib/rate-limit.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("drafter", { homeArea: "en" }); await h.signIn("limited"); });
afterAll(() => h.restore());
async function save(as: string, form: Record<string, string> = { intent: "draft", body: "Private reviewed content" }, headers?: Record<string, string>) {
  const { action } = await import("~/routes/topic-new");
  return h.outcome(() => action(h.args(h.request("/t/new", { as, form, headers }))));
}
it("saves an unsigned editor draft with parsed frontmatter without consuming publication allowance", async () => {
  const res = await save("drafter", { intent: "draft", body: "---\ntitle: Reviewed title\nlang: en\n---\nPrivate reviewed content" });
  expect(res).toMatchObject({ status: 302, location: expect.stringMatching(/^\/drafts\/\d+\?saved=1$/) });
  const [stored] = await h.db.select().from(drafts).where(eq(drafts.authorId, h.ids.drafter));
  expect(stored).toMatchObject({ kind: "topic", title: "Reviewed title", body: "Private reviewed content", lang: "en" });
  // Topic allowance is separate from draft allowance.
  const publication = await hitMemberLimit(h.db, "topic", h.ids.drafter);
  expect(publication.remaining).toBe(MEMBER_RATE_LIMITS.topic.limit - 1);
});
it("uses the shared draft allowance and returns the typed values when limited", async () => {
  for (let i = 0; i < DRAFT_RATE_LIMIT.limit; i++) await hitRateLimit(h.db, { key: `draft:member:${h.ids.limited}`, ...DRAFT_RATE_LIMIT });
  const res = await save("limited");
  expect(res).toMatchObject({ status: 429, value: { data: { error: "rate_limited", values: { body: "Private reviewed content" } } } });
});
it("retains input after invalid draft choices and enforces same-origin and writer gates", async () => {
  expect(await save("drafter", { intent: "draft", body: "Keep this", lang: "invalid" })).toMatchObject({ status: 400, value: { data: { error: "invalid_lang" } } });
  expect(await save("drafter", undefined, { origin: "https://foreign.example" })).toMatchObject({ status: 403 });
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, h.ids.drafter));
  expect(await save("drafter")).toMatchObject({ status: 302, location: "/suspended" });
});
