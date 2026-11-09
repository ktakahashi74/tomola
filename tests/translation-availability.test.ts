import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { entries, jobs, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { loadTranslationAvailability } from "~/lib/translation-availability.server";
import { translateDedupeKey } from "~/lib/translations.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { parseThreadBlocks } from "./helpers/md";

it("distinguishes hidden output and exhausted work from pending and requeued work", async () => {
  const db = await createTestDb(); await addMember(db, "availability", "availability");
  const made = await createTopic(db, "availability", { lang: "ja", body: "元の本文。" });
  if (!made.ok) throw new Error(made.error);
  const [row] = await db.select().from(entries).where(eq(entries.id, made.id));
  const input = { id: row.id, lang: "ja" as const, sourceHash: row.sourceHash };
  const state = async () => (await loadTranslationAvailability(db, [input], ["en"])).get(`${row.id}:en`);
  expect(await state()).toBe("pending");
  await db.delete(jobs);
  for (const flag of ["link_mismatch", "untranslated", "body_too_complex"]) {
    await db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "primary", text: "Hidden", sourceHash: row.sourceHash, flags: [flag] });
    expect(await state()).toBe("unavailable");
    await db.delete(translations);
  }
  const p = { entryId: row.id, lang: "en" as const, sourceHash: row.sourceHash! };
  await db.insert(jobs).values({ kind: "translate_entry", payload: p, status: "failed", dedupeKey: translateDedupeKey(p, "ja") });
  expect(await state()).toBe("unavailable");
  const display = (await loadEntryDisplays(db, [{ ...input, kind: "topic" }], { readLangs: ["en"], displayLang: "en" })).get(row.id);
  expect(display).toMatchObject({ pending: false, unavailable: true, translation: null });
  const md = parseThreadBlocks((await buildThreadMarkdown(db, row.id, { page: 1, lang: "all", sentences: false, k: null, readerId: "availability" }))!);
  expect(md[0].fm.translations_unavailable).toContain("en");
  expect(md[0].fm.translations_pending).not.toContain("en");
  await db.update(jobs).set({ status: "queued" });
  expect(await state()).toBe("pending");
  await db.update(jobs).set({ status: "failed", payload: { ...p, sourceHash: "old" } });
  expect(await state()).toBe("unrequested");
});

it("does no additional translation or job lookup for languages already selected for Markdown", async () => {
  const calls: string[] = [];
  const db = await createTestDb({ logger: { logQuery: query => { calls.push(query); } } });
  calls.length = 0;
  const available = new Map<number, readonly import("~/lib/languages").Lang[]>([[1, ["en"]]]);
  expect(await loadTranslationAvailability(db, [{ id: 1, lang: "ja", sourceHash: "h" }], ["en"], available)).toEqual(new Map());
  expect(calls).toEqual([]);
});
