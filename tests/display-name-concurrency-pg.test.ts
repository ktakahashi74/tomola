import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { displayNamesVersion, updateDisplayNames } from "~/lib/display-names.server";
import { createDisplayNameReport, moderateDisplayName } from "~/lib/display-name-moderation.server";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";

describe.skipIf(!PG_MODE)("display name changes on independent PostgreSQL connections", { tags: ["postgres"] }, () => {
  it.each(["settings-first", "moderation-first"])("preserves the new name with %s", async order => {
    const db = await createTestDb();
    for (const name of ["writer", "reporter", "operator"]) await addMember(db, name, `name_${name}`);
    await updateDisplayNames(db, "writer", "前の名前", "Old Name");
    const report = await createDisplayNameReport(db, "reporter", "writer", { reason: "other" });
    if (!report.ok) throw Error(report.error);
    const change = (tx: typeof db) => updateDisplayNames(tx, "writer", "新しい名前", "New Name");
    const moderate = (tx: typeof db) => moderateDisplayName(tx, { id: "operator", scope: { operator: true, langs: [] } }, { userId: "writer", reportId: report.id, version: displayNamesVersion({ displayName: "前の名前", displayNameLatin: "Old Name" }), dismiss: false, reason: "other", note: "Reported old name" });
    let enter!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = db.transaction(async tx => {
      const result = await (order === "settings-first" ? change(tx) : moderate(tx));
      expect(result.ok).toBe(true); enter(); await gate;
    });
    await inside;
    const queued = Promise.allSettled([order === "settings-first" ? moderate(db) : change(db)]);
    try {
      await expect.poll(async () => {
        const result = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
        return (result as unknown as { rows: { waiting: number }[] }).rows[0].waiting;
      }).toBeGreaterThan(0);
    } finally { release(); }
    await first;
    expect(await queued).toMatchObject([{ status: "fulfilled", value: order === "settings-first" ? { ok: false, error: "invalid_state" } : { ok: true } }]);
    expect(await db.select().from(profiles).where(eq(profiles.userId, "writer"))).toMatchObject([{ displayName: "新しい名前", displayNameLatin: "New Name", displayNameActionId: null }]);
  });
});
