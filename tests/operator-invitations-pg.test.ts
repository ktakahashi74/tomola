import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { invitations, rateLimits } from "~/lib/db/schema";
import { createOperatorInvitations } from "~/lib/operator-invitations.server";
import { hitRateLimit, MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectPending, holdTx, waitForLockWait } from "./helpers/pg-concurrency";

describe.skipIf(!REAL_PG_URL)("operator invitation allowance on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, admin: pg.Client;
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); });

  it("serializes concurrent batches and refuses the whole second batch when the remainder is too small", async () => {
    const first = await scratch.open("bulk-first"), second = await scratch.open("bulk-second");
    const actor = { id: "bulk_race", email: "bulk_race@example.com" };
    await addMember(first, actor.id, actor.id);
    await hitRateLimit(first, { key: `member:invitation:${actor.id}`, ...MEMBER_RATE_LIMITS.invitation, cost: 17 });
    const input = { villageId: null, note: "", locale: "en" as const, sendEmail: false };
    const held = holdTx(first, tx => createOperatorInvitations(tx, actor, { ...input, emails: ["bulk_race_a@example.com", "bulk_race_b@example.com"] }));
    expect(await held.ready).toMatchObject({ error: null });
    const waiting = createOperatorInvitations(second, actor, { ...input, emails: ["bulk_race_c@example.com", "bulk_race_d@example.com"] });
    try {
      await waitForLockWait(admin, "bulk-second");
      await expectPending(waiting);
    } finally { await held.commit(); }
    expect(await waiting).toMatchObject({ error: "rate_limited", rate: { remaining: 1 } });
    expect(await first.select().from(invitations).where(eq(invitations.createdBy, actor.id))).toHaveLength(2);
    expect((await first.select().from(rateLimits).where(eq(rateLimits.key, `member:invitation:${actor.id}`)))[0].count).toBe(19);
  });
});
