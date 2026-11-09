import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTopic } from "~/lib/entries.server";
import { hitMemberLimit, MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Per-member limits: preview 300/hour, reports 30/hour, invitations 20/day.
let h: RouteHarness;
let topicId: string;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("kim", { homeArea: "ja" });
  const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  topicId = String(topic.id);
});
afterAll(() => h.restore());

// Seed near the cap instead of performing hundreds of operations.
async function useUp(action: keyof typeof MEMBER_RATE_LIMITS, userId: string, count: number) {
  for (let i = 0; i < count; i++) await hitMemberLimit(h.db, action, userId);
}

describe("the limits", () => {
  it("are 300 and 30 per hour, and 20 invitations per day (and no limit for author translations)", () => {
    expect(MEMBER_RATE_LIMITS.invitation).toEqual({ limit: 20, windowSeconds: 86400 });
    expect(MEMBER_RATE_LIMITS.preview).toEqual({ limit: 300, windowSeconds: 3600 });
    expect(Object.keys(MEMBER_RATE_LIMITS)).not.toContain("author-translation");
    expect(MEMBER_RATE_LIMITS["translation-report"]).toEqual({ limit: 30, windowSeconds: 3600 });
  });

  it("count per member and per kind of action", async () => {
    const now = new Date("2026-10-01T00:10:00Z");
    for (let i = 0; i < 30; i++) expect((await hitMemberLimit(h.db, "translation-report", "u-a", now)).allowed).toBe(true);
    expect((await hitMemberLimit(h.db, "translation-report", "u-a", now)).allowed).toBe(false);
    expect((await hitMemberLimit(h.db, "translation-report", "u-b", now)).allowed).toBe(true);
    expect((await hitMemberLimit(h.db, "preview", "u-a", now)).allowed).toBe(true);
    expect((await hitMemberLimit(h.db, "translation-report", "u-a", new Date("2026-10-01T01:00:01Z"))).allowed).toBe(true);
  });
});

describe("preview", () => {
  it("answers 429 with Retry-After once a member has used 300 in the hour, and leaves other members alone", async () => {
    const { action } = await import("~/routes/preview");
    const preview = (as: string) => action(h.args(h.request("/preview", { as, form: { body: "hi" } }))) as Promise<Response>;
    expect((await preview("hana")).status).toBe(200);
    await useUp("preview", h.ids.hana, 299);
    const res = await preview("hana");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("x-ratelimit-limit")).toBe("300");
    expect((await preview("kim")).status).toBe(200);
  });
});

describe("invitations", () => {
  it("refuses the 21st invitation in a day with a 429 and a screen message, and creates nothing", async () => {
    const { action } = await import("~/routes/invites-new");
    const create = (as: string, email: string) => h.outcome(() => action(h.args(h.request("/invites/new", { as, form: { email } }))));
    const ok = await create("hana", "first@example.com");
    expect(ok).toMatchObject({ status: 200, value: { url: expect.stringContaining("/invite/"), error: null } });
    await useUp("invitation", h.ids.hana, 19);
    const { invitations } = await import("~/lib/db/schema");
    const before = (await h.db.select().from(invitations)).length;
    const refused = await create("hana", "second@example.com");
    expect(refused.status).toBe(429);
    expect((refused.value as { data: unknown }).data).toEqual({ url: null, error: "rate_limited" });
    expect((await h.db.select().from(invitations)).length).toBe(before);
    // Members have separate limits; reject invalid input before counting.
    expect((await create("kim", "third@example.com")).status).toBe(200);
    expect(await create("hana", "not-an-email")).toMatchObject({ status: 200, value: { error: "invalid_email" } });
  });
});

describe("translation reports", () => {
  it("refuses the 31st report in an hour with 429 and the same screen message", async () => {
    const route = await import("~/routes/topic");
    const report = () =>
      h.outcome(() =>
        route.action(h.args(h.request(`/t/${topicId}`, { as: "kim", form: { intent: "report", entryId: topicId, lang: "en", field: "body", excerpt: "x", note: "wrong" } }), { id: topicId })),
      );
    expect(await report()).toMatchObject({ status: 200, value: { data: { reported: true } } });
    await useUp("translation-report", h.ids.kim, 29);
    const refused = await report();
    expect(refused.status).toBe(429);
    expect((refused.value as { data: unknown }).data).toMatchObject({ intent: "report", error: "rate_limited", reported: false });
  });
});
