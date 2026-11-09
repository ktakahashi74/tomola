import { expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { handleHolds, profiles, user } from "~/lib/db/schema";
import { createProfile, changeHandle, getProfile } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";

const now = new Date("2026-10-03T00:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
async function setup() {
  const db = await createTestDb();
  for (const id of ["hana", "kim", "newbie"]) await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
  for (const id of ["hana", "kim"]) expect((await createProfile(db, id, { handle: id, homeArea: "ja" }, { now })).ok).toBe(true);
  return db;
}

it("allows the first rename and enforces the inclusive ninety-day deadline", async () => {
  const db = await setup();
  expect(await changeHandle(db, "hana", "hanna", { now })).toMatchObject({ ok: true });
  expect(await changeHandle(db, "hana", "hana2", { now: days(89) })).toEqual({ ok: false, error: "too_soon", nextChangeAt: days(90) });
  expect((await getProfile(db, "hana"))?.handle).toBe("hanna");
  expect(await changeHandle(db, "hana", "hana2", { now: days(90) })).toMatchObject({ ok: true });
});

it("does not consume first-change eligibility or modify the deadline for the same username", async () => {
  const db = await setup();
  expect(await changeHandle(db, "hana", "ＨＡＮＡ", { now })).toMatchObject({ ok: true });
  expect((await getProfile(db, "hana"))?.handleChangedAt).toBeNull();
});

it("keeps the old name unavailable for registration and changes, without exposing a hold-specific error", async () => {
  const db = await setup();
  expect(await changeHandle(db, "hana", "hanna", { now })).toMatchObject({ ok: true });
  expect(await createProfile(db, "newbie", { handle: "hana", homeArea: "ja" }, { now: days(89) })).toEqual({ ok: false, error: "handle_taken" });
  expect(await changeHandle(db, "kim", "hana", { now: days(89) })).toEqual({ ok: false, error: "handle_taken" });
  expect(await createProfile(db, "newbie", { handle: "hana", homeArea: "ja" }, { now: days(90) })).toMatchObject({ ok: true });
  expect(await db.execute(sql`select * from handle_holds where handle_key = 'hana'`)).toMatchObject({ rows: [] });
});

it("does not leave a hold or a cooldown change after a taken-name rejection", async () => {
  const db = await setup();
  expect(await changeHandle(db, "hana", "kim", { now })).toEqual({ ok: false, error: "handle_taken" });
  expect((await getProfile(db, "hana"))?.handleChangedAt).toBeNull();
  expect((await db.select().from(profiles).where(eq(profiles.userId, "hana")))[0].handle).toBe("hana");
  expect(await db.execute(sql`select * from handle_holds`)).toMatchObject({ rows: [] });
});

it("serializes simultaneous renames so the change limit cannot be bypassed", async () => {
  const db = await setup();
  const outcomes = await Promise.all([changeHandle(db, "hana", "hana1", { now }), changeHandle(db, "hana", "hana2", { now })]);
  expect(outcomes.filter(r => r.ok)).toHaveLength(1);
  expect(outcomes.filter(r => !r.ok)).toEqual([{ ok: false, error: "too_soon", nextChangeAt: days(90) }]);
});

it("returns to an active own hold without moving the ordinary rename deadline", async () => {
  const db = await setup();
  expect(await changeHandle(db, "hana", "hanna", { now })).toMatchObject({ ok: true });
  expect(await changeHandle(db, "hana", "ＨＡＮＡ", { now: days(1) })).toEqual({ ok: true, changed: true });
  expect((await getProfile(db, "hana"))?.handleChangedAt).toEqual(now);
  expect(await db.select().from(handleHolds)).toEqual([{ handleKey: "hanna", userId: "hana", heldUntil: days(91) }]);
  expect(await changeHandle(db, "hana", "hana2", { now: days(89) })).toEqual({ ok: false, error: "too_soon", nextChangeAt: days(90) });
  expect(await createProfile(db, "newbie", { handle: "hanna", homeArea: "ja" }, { now: days(90) })).toEqual({ ok: false, error: "handle_taken" });
  expect(await changeHandle(db, "hana", "hana2", { now: days(90) })).toEqual({ ok: true, changed: true });
  expect((await getProfile(db, "hana"))?.handleChangedAt).toEqual(days(90));
});

it("permits repeated returns while each hold is active and reserves each departed name anew", async () => {
  const db = await setup();
  await changeHandle(db, "hana", "hanna", { now });
  expect(await changeHandle(db, "hana", "hana", { now: days(2) })).toMatchObject({ ok: true });
  expect(await changeHandle(db, "hana", "hanna", { now: days(3) })).toMatchObject({ ok: true });
  expect((await getProfile(db, "hana"))?.handleChangedAt).toEqual(now);
  expect(await db.select().from(handleHolds)).toEqual([{ handleKey: "hana", userId: "hana", heldUntil: days(93) }]);
  expect(await changeHandle(db, "kim", "hana", { now: days(92) })).toEqual({ ok: false, error: "handle_taken" });
});

it("treats an expired own hold as an ordinary rename", async () => {
  const db = await setup();
  await changeHandle(db, "hana", "hanna", { now });
  expect(await changeHandle(db, "hana", "hana", { now: days(90) })).toEqual({ ok: true, changed: true });
  expect((await getProfile(db, "hana"))?.handleChangedAt).toEqual(days(90));
  expect(await changeHandle(db, "hana", "hana2", { now: days(91) })).toEqual({ ok: false, error: "too_soon", nextChangeAt: days(180) });
});
