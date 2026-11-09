import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, entryMedia, media } from "~/lib/db/schema";
import { addMember, createTestDb } from "./helpers/db";
import { migrationStatements } from "./helpers/migrations";

it("backfills existing original references once, including hidden and deleted posts", async () => {
  const db = await createTestDb();
  await addMember(db, "image_migration", "sec_image_migration");
  const id = "a".repeat(64), missing = "f".repeat(64);
  await db.insert(media).values({ id, bytes: Buffer.from("x"), mime: "image/webp", width: 1, height: 1, byteSize: 1, uploadedBy: "image_migration" });
  const path = `/media/${id}-1x1.webp`;
  await db.insert(entries).values([
    { kind: "topic", authorId: "image_migration", lang: "en", body: `![one](${path}) ![two](https://forum.example${path})`, hiddenAt: new Date() },
    { kind: "topic", authorId: "image_migration", lang: "en", body: `![deleted](${path})`, deletedAt: new Date() },
    { kind: "topic", authorId: "image_migration", lang: "en", body: `/media/${missing}-1x1.webp /media/${id}-0x1.webp` },
  ]);
  expect(await db.select().from(entryMedia)).toEqual([]);
  const backfill = migrationStatements("media_references").at(-1)!;
  await db.execute(sql.raw(backfill));
  await db.execute(sql.raw(backfill));
  const refs = await db.select().from(entryMedia);
  expect(refs).toHaveLength(2);
  expect(refs.every(row => row.mediaId === id)).toBe(true);
});
