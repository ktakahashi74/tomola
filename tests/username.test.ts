import { beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { profiles, user } from "~/lib/db/schema";
import { createProfile, changeHandle } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";

let db: Awaited<ReturnType<typeof createTestDb>>;
let serial = 0;
beforeAll(async () => { db = await createTestDb(); });
const signup = async (handle: string) => {
  const id = `username-${serial++}`;
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
  return { id, result: await createProfile(db, id, { handle, homeArea: "ja" }) };
};

it.each(["Hana", "ｈａｎａ", "ＨＡＮＡ"])("stores NFKC lowercase username %s", async handle => {
  const { id, result } = await signup(handle + serial);
  expect(result.ok).toBe(true);
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, id));
  expect(row.handle).toBe(handle.normalize("NFKC").toLowerCase() + (serial - 1));
  expect(row.handleKey).toBe(row.handle);
});

it.each(["高橋", "ha.na", "-hana", "_hana", "h", "h".repeat(31), "pаypal", "Αlpha", "ha\u200bna"])("refuses non-username input %s", async handle => {
  expect((await signup(handle)).result).toEqual({ ok: false, error: "invalid_handle" });
});

it.each(["admin", "administrator", "operator", "mod", "moderator", "staff", "official", "support", "help", "system", "root", "tomola", "api", "mcp", "ai", "bot", "everyone", "all", "here", "me", "you", "anonymous", "deleted", "unknown", "null", "undefined", "ＡＤＭＩＮ"])("reserves %s for signup and changes", async handle => {
  const { id, result } = await signup(handle);
  expect(result).toEqual({ ok: false, error: "handle_reserved" });
  expect(await changeHandle(db, id, handle)).toEqual({ ok: false, error: "handle_reserved" });
});
