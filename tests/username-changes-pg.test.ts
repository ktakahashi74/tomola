import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { user } from "~/lib/db/schema";
import { createProfile, changeHandle, getProfile } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";

describe.skipIf(!PG_MODE)("username claims on independent PostgreSQL connections", { tags: ["postgres"] }, () => {
  it.each(["rename-first", "signup-first"])("serializes signup and rename: %s", async order => {
    const db = await createTestDb();
    for (const id of ["hana", "newbie"]) await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
    const now = new Date();
    expect((await createProfile(db, "hana", { handle: "hana", homeArea: "ja" }, { now })).ok).toBe(true);
    let enter!: () => void; let release!: () => void;
    const inside = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = db.transaction(async tx => {
      const result = order === "rename-first"
        ? await changeHandle(tx, "hana", "hanna", { now })
        : await createProfile(tx, "newbie", { handle: "hanna", homeArea: "ja" }, { now });
      expect(result.ok).toBe(true);
      enter(); await gate; return result;
    });
    await inside;
    const queued = Promise.allSettled([order === "rename-first"
      ? createProfile(db, "newbie", { handle: "hana", homeArea: "ja" }, { now })
      : changeHandle(db, "hana", "hanna", { now })]);
    try {
      await expect.poll(async () => {
        const result = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
        return (result as unknown as { rows: { waiting: number }[] }).rows[0].waiting;
      }).toBeGreaterThan(0);
    } finally { release(); }
    expect((await first).ok).toBe(true);
    expect(await queued).toMatchObject([{ status: "fulfilled", value: { ok: false, error: "handle_taken" } }]);
    expect((await getProfile(db, "hana"))?.handle).toBe(order === "rename-first" ? "hanna" : "hana");
  });
});
