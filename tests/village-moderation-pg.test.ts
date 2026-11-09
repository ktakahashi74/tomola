import { moderateWithCurrentVersion as moderateVillage } from "./helpers/village-moderation";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { addMember } from "./helpers/db";
import { entries, villageMembers } from "~/lib/db/schema";
import { createVillage, editVillage } from "~/lib/village-management.server";
import { changeVillageMembership, ensureLanguageVillages, villageBySlug, villageForTopic } from "~/lib/villages.server";
import { createVillageReport } from "~/lib/village-moderation.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { createTopic } from "~/lib/entries.server";

describe.skipIf(!REAL_PG_URL)("village moderation concurrency on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, admin: pg.Client, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
    const db = await scratch.open("setup");
    const suffix = ++seq, owner = `vrpg_owner${suffix}`, other = `vrpg_other${suffix}`, operator = `vrpg_operator${suffix}`, reviewer = `vrpg_reviewer${suffix}`, slug = `moderated-race-${suffix}`;
    await ensureLanguageVillages(db);
    for (const id of [owner, other, operator, reviewer]) await addMember(db, id, id, { homeArea: "en" });
    await createVillage(db, owner, { slug, name: "Original village", description: "Original description", kind: "open" });
    await changeVillageMembership(db, other, slug, "join");
    const village = (await villageBySlug(db, slug))!;
    const reported = await createVillageReport(db, other, { slug, reason: "spam" });
    if (!reported.ok) throw new Error(reported.error);
    return { db, owner, other, operator, reviewer, slug, village, reportId: reported.id, actor: { id: operator, scope: { operator: true, langs: [] } } };
  }
  it("rejects all stale browser fields after waiting for an owner edit", async () => {
    const w = await world(), ownerDb = await scratch.open("owner-edit"), modDb = await scratch.open("mod-waiter");
    const held = holdTx(ownerDb, tx => editVillage(tx, w.owner, w.slug, { name: "Owner's committed name", description: "Owner's committed description" }));
    await held.ready;
    const fixing = moderateVillage(modDb, w.actor, { reportId: w.reportId, intent: "fix", name: "Original village", slug: w.slug, description: "Operator correction", reason: "spam", note: "Correction after owner's edit" });
    try { await waitForLockWait(admin, "mod-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(fixing, 10000, "moderation after owner edit")).toEqual({ ok: false, error: "stale" });
    expect(await villageBySlug(w.db, w.slug)).toMatchObject({ name: "Owner's committed name", description: "Owner's committed description" });
  });
  it("serializes a later owner edit and never overwrites it when overturning", async () => {
    const w = await world(), modDb = await scratch.open("moderation"), ownerDb = await scratch.open("owner-waiter");
    const held = holdTx(modDb, tx => moderateVillage(tx, w.actor, { reportId: w.reportId, intent: "fix", name: "Operator name", reason: "spam", note: "Correction" }));
    const action = await held.ready;
    if (!action.ok) throw new Error(action.error);
    const editing = editVillage(ownerDb, w.owner, w.slug, { name: "Later owner name", description: "Later owner description" });
    try { await waitForLockWait(admin, "owner-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(editing, 10000, "owner edit after moderation")).toMatchObject({ ok: true });
    const appealed = await createAppeal(w.db, w.owner, action.actionId, "Independent appeal");
    if (!appealed.ok) throw new Error(appealed.error);
    expect(await decideAppeal(w.db, { id: w.reviewer, scope: w.actor.scope }, appealed.id, { decision: "overturned", note: "Accepted" })).toMatchObject({ ok: true, reversed: false });
    expect(await villageBySlug(w.db, w.slug)).toMatchObject({ name: "Later owner name", description: "Later owner description" });
  });
  it("rechecks posting permission after a recorded ending commits", async () => {
    const w = await world(), modDb = await scratch.open("ending"), writer = await scratch.open("posting-waiter");
    const held = holdTx(modDb, tx => moderateVillage(tx, w.actor, { reportId: w.reportId, intent: "end", reason: "spam", note: "Recorded ending" }));
    expect(await held.ready).toMatchObject({ ok: true });
    const posting = createTopic(writer, w.other, { title: "Concurrent topic", body: "Concurrent body", lang: "en", village: w.slug });
    try { await waitForLockWait(admin, "posting-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(posting, 10000, "posting after ending")).toEqual({ ok: false, error: "village_required" });
    expect(await w.db.select().from(entries).where(eq(entries.villageId, w.village.id))).toEqual([]);
  });
  it("waits for an in-progress posting permission before recording the ending", async () => {
    const w = await world(), writer = await scratch.open("permission"), modDb = await scratch.open("ending-waiter");
    const held = holdTx(writer, tx => villageForTopic(tx, w.other, w.slug));
    expect(await held.ready).not.toBeNull();
    const ending = moderateVillage(modDb, w.actor, { reportId: w.reportId, intent: "end", reason: "spam", note: "Recorded ending" });
    try { await waitForLockWait(admin, "ending-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(ending, 10000, "ending after posting permission")).toMatchObject({ ok: true });
  });
  it("permits only one concurrent owner appeal and one concurrent open village report", async () => {
    const w = await world(), a = await scratch.open("appeal-a"), b = await scratch.open("appeal-b");
    await w.db.update(villageMembers).set({ role: "owner" }).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, w.other)));
    const fixed = await moderateVillage(w.db, w.actor, { reportId: w.reportId, intent: "fix", name: "Corrected", reason: "spam", note: "Correction" });
    if (!fixed.ok) throw new Error(fixed.error);
    const results = await expectSettlesWithin(Promise.all([createAppeal(a, w.owner, fixed.actionId, "First owner appeal"), createAppeal(b, w.other, fixed.actionId, "Second owner appeal")]), 10000, "concurrent owner appeals");
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "duplicate" }]);
    const reporting = await expectSettlesWithin(Promise.all([a, b].map(db => createVillageReport(db, w.other, { slug: w.slug, reason: "spam" }))), 10000, "concurrent village reports");
    expect(reporting.filter(r => r.ok)).toHaveLength(1);
    expect(reporting.filter(r => !r.ok)).toEqual([{ ok: false, error: "duplicate" }]);
  });
  it("serializes a concurrent claim of a slug replaced by a recorded correction", async () => {
    const w = await world(), modDb = await scratch.open("slug-replacement"), creator = await scratch.open("slug-claim-waiter");
    const held = holdTx(modDb, tx => moderateVillage(tx, w.actor, { reportId: w.reportId, intent: "fix", slug: `replaced-${seq}`, reason: "spam", note: "Replacing the address" }));
    expect(await held.ready).toMatchObject({ ok: true });
    const creating = createVillage(creator, w.other, { slug: w.slug, name: "Old address claimant", kind: "open", description: "" });
    try { await waitForLockWait(admin, "slug-claim-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(creating, 10000, "claim after slug replacement")).toEqual({ ok: false, error: "slug_taken" });
  });

});
