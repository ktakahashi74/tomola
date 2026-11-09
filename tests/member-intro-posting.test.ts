import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, profiles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { submitTopicForm } from "~/lib/entry-form.server";
import { buildMemberExport } from "~/lib/exports.server";
import { addMember, createTestDb } from "./helpers/db";

it("publishes and replaces an introduction within the topic transaction and exports the selection", async () => {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  const first = await createTopic(db, "u1", { lang: "ja", body: "My interests." }, { asIntroduction: true });
  if (!first.ok) throw new Error(first.error);
  expect((await db.select().from(profiles).where(eq(profiles.userId, "u1")))[0]).toHaveProperty("introEntryId", first.id);
  const second = await createTopic(db, "u1", { lang: "ja", body: "More interests." }, { asIntroduction: true });
  if (!second.ok) throw new Error(second.error);
  expect((await buildMemberExport(db, "u1")).profile).toHaveProperty("intro_entry_id", second.id);
  expect(await db.select().from(entries)).toHaveLength(2);
  await expect(db.transaction(async tx => {
    await createTopic(tx, "u1", { lang: "ja", body: "Rollback introduction" }, { asIntroduction: true });
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect((await buildMemberExport(db, "u1")).profile).toHaveProperty("intro_entry_id", second.id);
  expect(await db.select().from(entries)).toHaveLength(2);
});

it("rejects a question as an introduction before saving anything", async () => {
  const db = await createTestDb(); await addMember(db, "u1", "hana");
  expect(await createTopic(db, "u1", { lang: "ja", title: "Question", body: "Choose", asksStance: true }, { asIntroduction: true }))
    .toEqual({ ok: false, error: "invalid_intro" });
  expect(await db.select().from(entries)).toHaveLength(0);
});

it("checks the introduction/question conflict after interpreting pasted frontmatter", async () => {
  const db = await createTestDb(); await addMember(db, "u1", "hana");
  const form = new FormData(); form.set("intro", "1");
  form.set("body", "---\ntype: post\ntitle: Question\nasks_stance: true\n---\nChoose");
  expect(await submitTopicForm(db, { user: { id: "u1" }, profile: { homeArea: "ja", readLangs: ["ja"] } }, form))
    .toEqual({ ok: false, error: "invalid_intro" });
  expect(await db.select().from(entries)).toHaveLength(0);
});
