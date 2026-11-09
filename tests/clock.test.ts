import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PINNED_NOW } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

const DAY = 24 * 60 * 60 * 1000;

// The test clock starts near the fixed date 2026-09-30 regardless of wall time, then advances with elapsed real time (tests/helpers/clock.ts).
describe("the test clock", () => {
  it("starts near the pinned time whatever the real time is, and keeps flowing", async () => {
    expect(Math.abs(Date.now() - PINNED_NOW)).toBeLessThan(DAY);
    expect(Math.abs(new Date().getTime() - PINNED_NOW)).toBeLessThan(DAY);
    const a = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now()).toBeGreaterThan(a);
    expect(new Date().getTime()).toBeGreaterThanOrEqual(a);
  });

  it("leaves dates built from arguments, parsing and the string form alone", () => {
    expect(new Date("2020-01-02T03:04:05Z").toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(new Date(2020, 0, 2).getFullYear()).toBe(2020);
    expect(new Date(0).getTime()).toBe(0);
    expect(Date.parse("2026-10-01T00:00:00Z")).toBe(1790812800000);
    expect(Date.UTC(2026, 9, 1)).toBe(1790812800000);
    expect(new Date(NaN).getTime()).toBeNaN();
    expect(typeof Date()).toBe("string");
    const d = new Date();
    expect(d instanceof Date).toBe(true);
    expect(d.constructor === Date).toBe(true);
    expect(Object.prototype.toString.call(d)).toBe("[object Date]");
  });

  it("is the clock the database uses for now() and for the defaultNow() columns", async () => {
    const db = await createTestDb();
    const rows = (await db.execute(sql`select now() as t`)) as unknown as { rows: Array<{ t: Date | string }> };
    expect(Math.abs(new Date(rows.rows[0].t).getTime() - PINNED_NOW)).toBeLessThan(DAY);
  });
});
