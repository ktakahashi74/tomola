import { describe, expect, it } from "vitest";
import { rateLimits } from "~/lib/db/schema";
import { cleanupExpiredLimits, DRAFT_RATE_LIMIT, hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { createTestDb } from "./helpers/db";

const t0 = new Date("2026-10-01T10:15:30Z");

describe("hitRateLimit (fixed window in the database)", () => {
  it("has the API's default limits", () => {
    expect(DRAFT_RATE_LIMIT).toEqual({ limit: 30, windowSeconds: 3600 });
  });

  it("allows up to the limit, then refuses with the time left in the window", async () => {
    const db = await createTestDb();
    const rule = { key: "k1", limit: 3, windowSeconds: 3600 };
    for (let i = 1; i <= 3; i++) {
      const r = await hitRateLimit(db, { ...rule, now: t0 });
      expect(r).toMatchObject({ allowed: true, count: i, limit: 3, remaining: 3 - i, retryAfterSeconds: 0 });
    }
    const refused = await hitRateLimit(db, { ...rule, now: t0 });
    // Hourly windows start at minute zero. From 10:15:30 to 11:00:00 is 44 minutes 30 seconds.
    expect(refused).toMatchObject({ allowed: false, count: 4, remaining: 0, retryAfterSeconds: 2670, resetAt: new Date("2026-10-01T11:00:00Z") });
    expect(rateLimitHeaders(refused)).toEqual({
      "X-RateLimit-Limit": "3",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(new Date("2026-10-01T11:00:00Z").getTime() / 1000),
      "Retry-After": "2670",
    });
    expect(rateLimitHeaders(await hitRateLimit(db, { ...rule, key: "other", now: t0 }))).not.toHaveProperty("Retry-After");
  });

  it("counts each key separately and starts over in the next window", async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i++) await hitRateLimit(db, { key: "a", limit: 2, windowSeconds: 60, now: t0 });
    expect((await hitRateLimit(db, { key: "b", limit: 2, windowSeconds: 60, now: t0 })).allowed).toBe(true);
    expect((await hitRateLimit(db, { key: "a", limit: 2, windowSeconds: 60, now: t0 })).allowed).toBe(false);
    // The next window starts at 10:16:00 because t0 is 10:15:30.
    const next = await hitRateLimit(db, { key: "a", limit: 2, windowSeconds: 60, now: new Date("2026-10-01T10:16:00Z") });
    expect(next).toMatchObject({ allowed: true, count: 1 });
    // The preceding window lasts through one millisecond before its end.
    expect((await hitRateLimit(db, { key: "a", limit: 2, windowSeconds: 60, now: new Date("2026-10-01T10:15:59.999Z") })).count).toBe(7);
  });

  it("counts concurrent hits without losing any", async () => {
    const db = await createTestDb();
    const results = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit(db, { key: "race", limit: 10, windowSeconds: 3600, now: t0 })));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("leaves cleanup to maintenance and removes only expired windows", async () => {
    const db = await createTestDb();
    await hitRateLimit(db, { key: "old", limit: 5, windowSeconds: 60, now: t0 });
    await hitRateLimit(db, { key: "live", limit: 5, windowSeconds: 3600, now: t0 });
    expect(await db.select().from(rateLimits)).toHaveLength(2);
    // The first count in the new window two minutes later removes the expired old window; live remains because its window is still active.
    await hitRateLimit(db, { key: "fresh", limit: 5, windowSeconds: 60, now: new Date(t0.getTime() + 120_000) });
    expect(await db.select().from(rateLimits)).toHaveLength(3);
    await cleanupExpiredLimits(db, new Date(t0.getTime() + 120_000));
    const keys = (await db.select().from(rateLimits)).map((r) => r.key).sort();
    expect(keys).toEqual(["fresh", "live"]);
  });

  it("rejects an invalid rule", async () => {
    const db = await createTestDb();
    for (const bad of [{ limit: 0, windowSeconds: 60 }, { limit: 1.5, windowSeconds: 60 }, { limit: 1, windowSeconds: 0 }, { limit: -1, windowSeconds: 60 }]) {
      await expect(hitRateLimit(db, { key: "x", ...bad })).rejects.toThrow(RangeError);
    }
  });
});
