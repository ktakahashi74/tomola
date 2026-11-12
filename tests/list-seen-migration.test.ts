import { expect, it } from "vitest";
import { listSeen, profiles, user } from "~/lib/db/schema";
import { addMember, createTestDb } from "./helpers/db";
import { migrationStatements } from "./helpers/migrations";

it("adds list watermarks without changing existing accounts and enforces their keys and scope", async () => {
  const db = await createTestDb();
  await addMember(db, "watermark_migration", "watermark_migration");
  await db.execute("drop table list_seen");
  const before = { users: await db.select().from(user), profiles: await db.select().from(profiles) };
  for (const statement of migrationStatements("list_seen")) await db.execute(statement);
  expect({ users: await db.select().from(user), profiles: await db.select().from(profiles) }).toEqual(before);
  const row = { userId: "watermark_migration", scope: "/", seenAt: new Date("2026-01-01T00:00:00Z") };
  await db.insert(listSeen).values(row);
  await expect(db.insert(listSeen).values(row)).rejects.toThrow();
  await expect(db.insert(listSeen).values({ ...row, userId: "missing" })).rejects.toThrow();
  for (const scope of ["/t/1", `/v/${"a".repeat(68)}`]) await expect(db.insert(listSeen).values({ ...row, scope })).rejects.toThrow();
  expect(await db.select().from(listSeen)).toMatchObject([row]);
});
