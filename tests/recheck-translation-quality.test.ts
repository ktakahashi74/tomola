import { asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, jobs, translations, translationRevisions } from "~/lib/db/schema";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { createTopic, editEntry } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { runTranslationQualityRecheck } from "../scripts/recheck-translation-quality";
import { captureCli } from "./helpers/cli";
import { addMember, createTestDb } from "./helpers/db";

it("previews and repairs only matching current machine translations, restoring the reading view", async () => {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  const title = String.raw`値 $x_{\text{平均}}$`;
  const body = String.raw`測定値は $3.4\times10^{-7}$ です。`;
  const topic = await createTopic(db, "u1", { lang: "ja", title, body });
  const edited = await createTopic(db, "u1", { lang: "ja", title, body });
  if (!topic.ok || !edited.ok) throw new Error("Test topics could not be created");
  const [current] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const [old] = await db.select().from(entries).where(eq(entries.id, edited.id));
  const french = String.raw`La mesure vaut $3,4\times10^{-7}$.`;
  const flagged = ["quality_mismatch"];
  const input = { entryId: current.id, sourceHash: current.sourceHash, field: "body", kind: "primary", engine: "gemini", flags: flagged };
  const [restored, titleRow, corrupted, wrongLocale, otherFlag, secondary, human, changed, late] = await db.insert(translations).values([
    { ...input, lang: "fr", text: french, flags: [...flagged, "structure_mismatch"], html: "<p>Old cache</p>", htmlVersion: 1, cardHtml: "<p>Old card</p>" },
    { ...input, lang: "fr", field: "title", text: String.raw`Valeur $x_{\text{moyenne}}$` },
    { ...input, lang: "de", text: String.raw`Der Messwert ist $3,5\times10^{-7}$.` },
    { ...input, lang: "en", text: String.raw`The value is $3,4\times10^{-7}$.` },
    { ...input, lang: "vi", text: "Giá trị là $3,4\\times10^{-7}$. https://example.com/", flags: [...flagged, "link_mismatch"] },
    { ...input, lang: "fr", text: french, kind: "secondary" },
    { ...input, lang: "ko", text: french, kind: "human" },
    { ...input, lang: "th", text: "ค่าคือ $3.4\\times10^{-7}$", sourceHash: "older" },
    { ...input, entryId: old.id, sourceHash: old.sourceHash, lang: "fr", text: french },
  ]).returning();
  const view = () => loadEntryDisplays(db, [{ id: current.id, kind: "topic", sourceHash: current.sourceHash, lang: "ja" }], { readLangs: ["fr"], displayLang: "fr" });
  const list = () => db.select().from(translations).orderBy(asc(translations.id));
  const run = (args: string[]) => captureCli(output => runTranslationQualityRecheck(args, async () => db, output));
  const before = await list();
  expect((await view()).get(current.id)?.translation).toBeNull();
  expect(await run([])).toEqual({ status: 0, stdout: JSON.stringify({ count: 5, ids: [restored.id, titleRow.id, otherFlag.id, secondary.id, late.id] }) + "\n", stderr: "" });
  expect(await list()).toEqual(before);

  // Change the source after preview. The previously listed translation must be skipped.
  expect(await editEntry(db, "u1", old.id, { lang: "ja", title, body: body.replace("3.4", "4.4") })).toMatchObject({ ok: true, changed: true });
  const editedBefore = (await list()).find(row => row.id === late.id);
  const jobsBefore = await db.select().from(jobs);
  const revisionsBefore = await db.select().from(translationRevisions);
  expect(await run(["--apply"])).toEqual({ status: 0, stdout: JSON.stringify({ count: 4, ids: [restored.id, titleRow.id, otherFlag.id, secondary.id] }) + "\n", stderr: "" });

  const byId = new Map((await list()).map(row => [row.id, row]));
  expect(byId.get(restored.id)).toMatchObject({ flags: ["structure_mismatch"], text: french, htmlVersion: RENDER_VERSION, cardHtml: null });
  expect(byId.get(titleRow.id)).toMatchObject({ flags: [], html: null });
  expect(byId.get(otherFlag.id)?.flags).toEqual(["link_mismatch"]);
  expect(byId.get(secondary.id)).toMatchObject({ flags: [], html: null });
  for (const id of [corrupted.id, wrongLocale.id, human.id, changed.id]) expect(byId.get(id)).toEqual(before.find(row => row.id === id));
  expect(byId.get(late.id)).toEqual(editedBefore);
  expect(await db.select().from(jobs)).toEqual(jobsBefore);
  expect(await db.select().from(translationRevisions)).toEqual(revisionsBefore);
  expect((await view()).get(current.id)).toMatchObject({
    shown: "translation",
    translation: { kind: "primary", title: { text: titleRow.text }, html: expect.stringContaining("La mesure vaut") },
  });
  expect(byId.get(restored.id)?.html).toContain("katex");
  expect(await run(["--apply"])).toEqual({ status: 0, stdout: '{"count":0,"ids":[]}\n', stderr: "" });
});
