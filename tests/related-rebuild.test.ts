import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, entryReferences } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { rebuildEntryReferences } from "~/lib/related-discussions.server";
import { addMember, createTestDb } from "./helpers/db";

it("rebuilds a bounded original-post range only with explicit write, preserving bodies, activity and edit times", async () => {
  const db = await createTestDb();
  await addMember(db, "rebuild_author", "rebuild_author");
  const target = await createTopic(db, "rebuild_author", { lang: "en", title: "Target", body: "Target body" });
  if (!target.ok) throw new Error(target.error);
  const sources: number[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await createTopic(db, "rebuild_author", { lang: "en", title: "Old source", body: `[link](/t/${target.id})` });
    if (!result.ok) throw new Error(result.error);
    sources.push(result.id);
  }
  await db.delete(entryReferences);
  const before = await db.select().from(entries);
  expect(await rebuildEntryReferences(db, { fromId: sources[0], toId: sources[2], limit: 1 })).toEqual({ checked: 1, changed: 1, nextId: sources[1] });
  expect(await db.select().from(entryReferences)).toEqual([]);
  expect(await db.select().from(entries)).toEqual(before);
  expect(await rebuildEntryReferences(db, { fromId: sources[0], toId: sources[1], write: true, now: new Date("2030-01-01") })).toEqual({ checked: 2, changed: 2, nextId: null });
  expect(await db.select().from(entryReferences)).toEqual(sources.slice(0, 2).map(sourceEntryId => ({ sourceEntryId, targetEntryId: target.id })));
  const after = await db.select().from(entries);
  for (const row of after) {
    const original = before.find(entry => entry.id === row.id)!;
    expect(row).toMatchObject({ body: original.body, lastActivityAt: original.lastActivityAt, editedAt: original.editedAt });
  }
  expect(await rebuildEntryReferences(db, { fromId: sources[0], toId: sources[1], write: true, now: new Date("2031-01-01") })).toMatchObject({ changed: 0 });
  expect(await db.select().from(entries).where(eq(entries.id, target.id))).toEqual(after.filter(row => row.id === target.id));
});

it.each([{ fromId: 0, toId: 3 }, { fromId: 3, toId: 1 }, { fromId: 1, toId: 3, limit: 0 }, { fromId: 1, toId: 3, limit: 1001 }])("rejects an unbounded or invalid rebuild range", async options => {
  const db = await createTestDb();
  await expect(rebuildEntryReferences(db, options)).rejects.toThrow(RangeError);
});
