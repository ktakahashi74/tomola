import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { profiles } from "~/lib/db/schema";
import { AVATAR_EDGE } from "~/lib/avatar-image.server";
import { setMemberAvatar } from "~/lib/member-avatar.server";
import { createAvatarReport, moderateAvatar } from "~/lib/avatar-moderation.server";
import { parseMediaPath } from "~/lib/media";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";

describe.skipIf(!PG_MODE)("avatar changes across PostgreSQL connections", { tags: ["postgres"] }, () => {
  it.each(["settings-first", "moderation-first"].flatMap(order => ["reset", "replace"].map(change => ({ order, change }))))("serializes $change with $order", async ({ order, change: operation }) => {
    const db = await createTestDb();
    for (const name of ["writer", "reporter", "operator"]) await addMember(db, name, `avatar_${name}`);
    const image = { width: AVATAR_EDGE, height: AVATAR_EDGE, bytes: await sharp({ create: { width: AVATAR_EDGE, height: AVATAR_EDGE, channels: 3, background: "#789" } }).webp().toBuffer() };
    const first = await setMemberAvatar(db, "writer", image), id = parseMediaPath(first.url)!.id;
    const report = await createAvatarReport(db, "reporter", "writer", { reason: "other" });
    if (!report.ok) throw Error(report.error);
    const replacement = { ...image, bytes: await sharp(image.bytes).negate().webp().toBuffer() };
    const change = (tx: typeof db) => setMemberAvatar(tx, "writer", operation === "reset" ? null : replacement);
    const moderate = (tx: typeof db) => moderateAvatar(tx, { id: "operator", scope: { operator: true, langs: [] } }, { userId: "writer", reportId: report.id, version: id, dismiss: false, reason: "other", note: "Review" });
    let enter!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const firstWork = db.transaction(async tx => {
      const result = await (order === "settings-first" ? change(tx) : moderate(tx));
      expect(result).not.toHaveProperty("error"); enter(); await gate;
    });
    await inside;
    const queued = Promise.allSettled([order === "settings-first" ? moderate(db) : change(db)]);
    try {
      await expect.poll(async () => {
        const result = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
        return (result as unknown as { rows: { waiting: number }[] }).rows[0].waiting;
      }).toBeGreaterThan(0);
    } finally { release(); }
    await firstWork;
    expect(await queued).toMatchObject([{ status: "fulfilled", value: order === "settings-first" ? { ok: false, error: "invalid_state" } : { uploaded: operation !== "reset" } }]);
    const [person] = await db.select().from(profiles).where(eq(profiles.userId, "writer"));
    expect(person.avatarActionId).toBeNull();
    if (operation === "reset") expect(person.avatarMediaId).toBeNull();
    else { expect(person.avatarMediaId).not.toBeNull(); expect(person.avatarMediaId).not.toBe(id); }
  });
});
