import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { listSeen } from "~/lib/db/schema";
import { exchangeListSeen } from "~/lib/list-seen.server";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("list boundaries across PostgreSQL connections", { tags: ["postgres"] }, () => {
  it("serializes first exchanges and trimming across devices and scopes", async () => {
    const scratch = await createScratchDb();
    try {
      const a = await scratch.open();
      const b = await scratch.open();
      await addMember(a, "watermark_pg", "watermark_pg");
      const older = new Date("2026-01-01T00:00:00Z");
      const newer = new Date("2026-01-02T00:00:00Z");
      const previous = await Promise.all([
        exchangeListSeen(a, "watermark_pg", "/", older),
        exchangeListSeen(b, "watermark_pg", "/", newer),
      ]);
      expect(previous.filter(value => value === null)).toHaveLength(1);
      expect(previous.find(value => value !== null)).toMatch(/2026-01-0[12]T/);
      expect((await a.select().from(listSeen))[0].seenAt).toEqual(newer);
      await a.delete(listSeen).where(eq(listSeen.userId, "watermark_pg"));
      await a.insert(listSeen).values(Array.from({ length: 49 }, (_, index) => ({ userId: "watermark_pg", scope: `/v/list-${index}`, seenAt: older, updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)) })));
      await Promise.all([
        exchangeListSeen(a, "watermark_pg", "/", newer),
        exchangeListSeen(b, "watermark_pg", "/a/en", newer),
        exchangeListSeen(a, "watermark_pg", "/a/ja", newer),
      ]);
      const rows = await b.select().from(listSeen);
      expect(rows).toHaveLength(50);
      expect(rows.map(row => row.scope)).toEqual(expect.arrayContaining(["/", "/a/en", "/a/ja"]));
      expect(rows.map(row => row.scope)).not.toContain("/v/list-0");
      expect(rows.map(row => row.scope)).not.toContain("/v/list-1");
    } finally { await scratch.drop(); }
  });
});
