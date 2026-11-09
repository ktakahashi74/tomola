import { trialForm } from "./helpers/trial";


import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles, user } from "~/lib/db/schema";
import { handleKey } from "~/lib/handles";
import { createProfile } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

const valid = { homeArea: "ja", readLangs: ["ja"] };
async function addUser(db: Db, id: string) {
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
}

describe("handleKey", () => {
  it("is the same for names that differ only in case, width or normalization form", () => {
    const same = [
      ["Hana", "hana", "HANA", "ＨＡＮＡ", "ｈａｎａ", "Ｈana"],
      ["Ärger", "ärger", "Ärger", "Ａ̈rger"],
      ["하나", "하나".normalize("NFD")],
      ["ⅷ", "Ⅷ", "viii", "VIII"],
      ["ℂat", "Cat", "cat"],
      ["ΟΔΟΣ", "οδοσ", "οδος".replace("ς", "σ")],
      ["İstanbul", "istanbul", "ISTANBUL"],
      ["ﬃ", "ffi"],
    ];
    for (const group of same) for (const name of group) expect(handleKey(name), `${name} in ${group[0]}`).toBe(handleKey(group[0]));
  });

  it("differs for different names", () => {
    expect(handleKey("hana")).not.toBe(handleKey("hanna"));
    expect(handleKey("hana")).not.toBe(handleKey("hana_"));
    // Legacy keys remain distinct for visually similar Latin a and Cyrillic а.
    expect(handleKey("a")).not.toBe(handleKey("а"));
  });

  it("is idempotent", () => {
    for (const name of ["ＨＡＮＡ", "ΟΔΟΣ", "İ", "ǅ", "Ǆ", "ẞ"]) expect(handleKey(handleKey(name))).toBe(handleKey(name));
  });
});

describe("profiles: the handle key", () => {
  it("rejects a name that differs from an existing one only in case or width", async () => {
    const db = await createTestDb();
    const variants = ["Hana", "HANA", "ＨＡＮＡ", "hAnA"];
    await addUser(db, "u0");
    expect((await createProfile(db, "u0", { ...valid, handle: "hana" })).ok).toBe(true);
    for (const [i, handle] of variants.entries()) {
      await addUser(db, `v${i}`);
      expect(await createProfile(db, `v${i}`, { ...valid, handle }), handle).toEqual({ ok: false, error: "handle_taken" });
    }
    // A different name succeeds.
    await addUser(db, "w1");
    expect((await createProfile(db, "w1", { ...valid, handle: "hana2" })).ok).toBe(true);
    const [row] = await db.select({ key: profiles.handleKey }).from(profiles).where(eq(profiles.userId, "u0"));
    expect(row.key).toBe("hana");
  });

  it("the unique index itself refuses a second row with the same key, and a race ends as handle_taken", async () => {
    const db = await createTestDb();
    await addUser(db, "a");
    await addUser(db, "b");
    const results = await Promise.all([createProfile(db, "a", { ...valid, handle: "Hana" }), createProfile(db, "b", { ...valid, handle: "hana" })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "handle_taken" }]);
    expect(await db.select().from(profiles)).toHaveLength(1);
    await expect(
      db.insert(profiles).values({ userId: "b", handle: "different", handleKey: (await db.select().from(profiles))[0].handleKey, homeArea: "ja" }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "profiles_handle_key_unique" } });
  });

  it("rejects non-ASCII and mixed-script names as invalid_handle", async () => {
    const db = await createTestDb();
    await addUser(db, "m1");
    for (const handle of ["pаypal", "Αlpha", "Иван_Ivan", "Иван", "高橋"]) {
      expect(await createProfile(db, "m1", { ...valid, handle }), handle).toEqual({ ok: false, error: "invalid_handle" });
    }
    expect(await createProfile(db, "m1", { ...valid, handle: "pа ypal" })).toEqual({ ok: false, error: "invalid_handle" });
    expect(await createProfile(db, "m1", { ...valid, handle: "ivan_2026" })).toMatchObject({ ok: true });
  });
});

describe("onboarding", () => {
  let h: RouteHarness;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("newbie", { profile: false });
  });
  afterAll(() => h.restore());

  const submit = async (handle: string) => {
    const { action } = await import("~/routes/onboarding");
    return h.outcome(() => action(h.args(h.request("/onboarding", { as: "newbie", form: { ...trialForm, handle, homeArea: "ja", readLangs: ["ja"] } }))));
  };

  it("shows the matching error for a taken, invalid, reserved or available username", async () => {
    expect(await submit("HANA")).toMatchObject({ status: 200, value: { error: "handle_taken" } });
    expect(await submit("Ｈａｎａ")).toMatchObject({ value: { error: "handle_taken" } });
    expect(await submit("pаypal")).toMatchObject({ value: { error: "invalid_handle" } });
    expect(await submit("ADMIN")).toMatchObject({ value: { error: "handle_reserved" } });
    expect(await submit("x")).toMatchObject({ value: { error: "invalid_handle" } });
    expect(await submit("newbie")).toMatchObject({ status: 302, location: "/" });
  });
});
