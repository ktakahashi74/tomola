import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { profiles, user } from "~/lib/db/schema";
import { HandleKeyCollisionError, recomputeHandleKeys } from "~/lib/handle-keys.server";
import { handleKey } from "~/lib/handles";
import { createProfile } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";

// Recompute handle_key after migrations, called by pnpm db:migrate (app/lib/handle-keys.server.ts).
async function addProfile(db: Db, id: string, handle: string) {
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
  const res = await createProfile(db, id, { handle, homeArea: "ja", readLangs: ["ja"] });
  if (!res.ok) throw new Error(`profile failed: ${res.error}`);
}
const keyOf = async (db: Db, id: string) => (await db.select({ key: profiles.handleKey }).from(profiles).where(eq(profiles.userId, id)))[0].key;
const setKey = (db: Db, id: string, key: string) => db.update(profiles).set({ handleKey: key }).where(eq(profiles.userId, id));

describe("recomputeHandleKeys", () => {
  it("leaves rows whose key already matches alone", async () => {
    const db = await createTestDb();
    await addProfile(db, "u1", "Hana");
    await addProfile(db, "u2", "kim");
    expect(await recomputeHandleKeys(db)).toEqual({ checked: 2, fixed: [] });
  });

  it("fixes only the rows whose stored key differs from the application's key", async () => {
    const db = await createTestDb();
    await addProfile(db, "u1", "Hana");
    await addProfile(db, "u2", "istanbul");
    await addProfile(db, "u3", "kim");
    // Reproduce a legacy Unicode row only inside this isolated database.
    await db.execute(sql`alter table profiles drop constraint profiles_handle_check`);
    await db.execute(sql`update profiles set handle = 'İstanbul' where user_id = 'u2'`);
    // A key produced by lower under a different collation, mapping İ to i plus combining dot, and a completely wrong key.
    await setKey(db, "u2", "i̇stanbul");
    await setKey(db, "u3", "KIM");
    const res = await recomputeHandleKeys(db);
    expect(res.checked).toBe(3);
    expect(res.fixed.sort()).toEqual(["kim", "İstanbul"]);
    expect(await keyOf(db, "u1")).toBe("hana");
    expect(await keyOf(db, "u2")).toBe(handleKey("İstanbul"));
    expect(await keyOf(db, "u3")).toBe("kim");
    // The second run does nothing.
    expect((await recomputeHandleKeys(db)).fixed).toEqual([]);
  });

  it("handles keys that swap between two rows without tripping the unique index half way", async () => {
    const db = await createTestDb();
    await addProfile(db, "u1", "alpha");
    await addProfile(db, "u2", "beta");
    await setKey(db, "u1", "tmp");
    await setKey(db, "u2", "alpha");
    await setKey(db, "u1", "beta");
    const res = await recomputeHandleKeys(db);
    expect(res.fixed.sort()).toEqual(["alpha", "beta"]);
    expect(await keyOf(db, "u1")).toBe("alpha");
    expect(await keyOf(db, "u2")).toBe("beta");
  });

  it("fails loudly, naming the names, when two names have the same key; nothing is changed", async () => {
    const db = await createTestDb();
    await addProfile(db, "u1", "Hana");
    await addProfile(db, "u2", "kim");
    // Reproduce legacy names that were distinct under old keys but now collide.
    await db.execute(sql`alter table profiles drop constraint profiles_handle_check`);
    await db.execute(sql`update profiles set handle = 'ＨＡＮＡ' where user_id = 'u2'`);
    await setKey(db, "u2", "ＨＡＮＡ-old");
    const error = await recomputeHandleKeys(db).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HandleKeyCollisionError);
    expect((error as Error).message).toContain("handle_key collision");
    expect((error as Error).message).toContain('"hana"');
    expect((error as Error).message).toContain('"ＨＡＮＡ"');
    expect(await keyOf(db, "u2")).toBe("ＨＡＮＡ-old");
  });
});
