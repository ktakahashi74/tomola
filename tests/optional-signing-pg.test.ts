import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { PG_MODE } from "./helpers/pg-test";
import { attachSigningProof, signingCredential } from "./helpers/signing";
import { createTopic } from "~/lib/entries.server";
import { profiles } from "~/lib/db/schema";
import { withSignedWrite } from "~/lib/signing.server";

describe.skipIf(!PG_MODE)("preference and posting serialization on independent PostgreSQL connections", { tags: ["postgres"] }, () => {
  let h: RouteHarness;
  beforeAll(async () => { h = await setupRouteHarness(); });
  afterAll(() => h?.restore());
  it.each(["post-first", "preference-first"])("orders an unsigned post and signed opt-in: %s", async order => {
    await h.signIn(order);
    const userId = h.ids[order]; const key = await signingCredential(h.db, userId);
    const request = await attachSigningProof(h.db, userId, h.request("/settings", { as: order, form: { intent: "sign-posts", signPosts: "1" } }), key);
    const preferenceForm = await request.formData();
    const postForm = new FormData(); postForm.set("body", `Concurrent ${order}`); postForm.set("lang", "ja");
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const post = (hold: boolean) => withSignedWrite(h.db, userId, h.request("/t/new"), postForm, async tx => {
      if (hold) { entered(); await gate; }
      return createTopic(tx, userId, { body: `Concurrent ${order}`, lang: "ja" });
    });
    const preference = (hold: boolean) => withSignedWrite(h.db, userId, request, preferenceForm, async tx => {
      await tx.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, userId));
      if (hold) { entered(); await gate; }
      return { ok: true };
    });
    const first = order === "post-first" ? post(true) : preference(true);
    await inside;
    // Attach a rejection handler immediately; preference-first must reject the queued unsigned write.
    const second = Promise.allSettled([order === "post-first" ? preference(false) : post(false)]);
    try {
      await expect.poll(async () => {
        const result = await h.db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
        return (result as unknown as { rows: { waiting: number }[] }).rows[0].waiting;
      }).toBeGreaterThan(0);
    } finally { release(); }
    expect(await first).toMatchObject({ ok: true });
    const [outcome] = await second;
    if (order === "post-first") expect(outcome).toMatchObject({ status: "fulfilled", value: { ok: true } });
    else expect(outcome).toMatchObject({ status: "rejected", reason: { status: 403 } });
    expect((await h.db.select().from(profiles).where(eq(profiles.userId, userId)))[0].signPosts).toBe(true);
  });
});
