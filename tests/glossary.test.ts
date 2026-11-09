import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import {
  createGlossaryEntry,
  deleteGlossaryEntry,
  listGlossary,
  parseCandidates,
  updateGlossaryEntry,
} from "~/lib/glossary.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { TranslationRequest } from "~/lib/llm/types";
import { getGlossaryVersion, glossaryVersionOf, matchGlossary } from "~/lib/translations.server";
import type { GlossaryActor } from "~/lib/glossary.server";
import { addMember, createTestDb } from "./helpers/db";

// Operator with permission to edit all languages.
const op: GlossaryActor = { userId: "op", scope: { operator: true, langs: [] } };
const t0 = new Date("2026-10-05T00:00:00Z");
const t1 = new Date("2026-10-06T00:00:00Z");

async function setup() {
  const db = await createTestDb();
  await addMember(db, "op", "opal");
  return db;
}

describe("glossary CRUD", () => {
  it("adds, lists, edits and deletes entries (candidates, note, keep-original)", async () => {
    const db = await setup();
    const created = await createGlossaryEntry(db, op, { term: " 整合性 ", lang: "ja", targetLang: "en", candidates: "alignment\n\n consistency \nalignment", note: " AI safety ", keepOriginal: false }, { now: t0 });
    if (!created.ok) throw new Error("create failed");
    const keep = await createGlossaryEntry(db, op, { term: "RLHF", lang: "ja", targetLang: "en", candidates: "", keepOriginal: "on" }, { now: t0 });
    expect(keep.ok).toBe(true);
    const { entries: list } = await listGlossary(db);
    expect(list.map((e) => e.term)).toEqual(["RLHF", "整合性"]);
    expect(list.find((e) => e.term === "整合性")).toMatchObject({ candidates: ["alignment", "consistency"], note: "AI safety", keepOriginal: false, lang: "ja", targetLang: "en" });
    expect(list.find((e) => e.term === "RLHF")).toMatchObject({ candidates: [], keepOriginal: true });
    const updated = await updateGlossaryEntry(db, op, created.id, { term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment", note: "", keepOriginal: true }, { now: t1 });
    expect(updated).toEqual({ ok: true, changed: true });
    expect((await listGlossary(db)).entries.find((e) => e.id === created.id)).toMatchObject({ candidates: ["alignment"], note: "", keepOriginal: true });
    expect(await deleteGlossaryEntry(db, op, created.id)).toEqual({ ok: true });
    expect(await deleteGlossaryEntry(db, op, created.id)).toEqual({ ok: false, error: "not_found" });
    expect((await listGlossary(db)).entries.map((e) => e.term)).toEqual(["RLHF"]);
    // Deleted entries retain rows with deleted_at and appear in the deleted list.
    expect((await listGlossary(db, { deleted: true })).entries.map((e) => e.term)).toEqual(["整合性"]);
    expect(await updateGlossaryEntry(db, op, 9999, { term: "x", lang: "ja", targetLang: "en" })).toEqual({ ok: false, error: "not_found" });
  });

  it("validates input and rejects duplicates of (term, language, target)", async () => {
    const db = await setup();
    const err = async (input: Parameters<typeof createGlossaryEntry>[2]) => {
      const res = await createGlossaryEntry(db, op, input);
      return res.ok ? "ok" : res.error;
    };
    expect(await err({ term: "  ", lang: "ja", targetLang: "en" })).toBe("invalid_term");
    expect(await err({ term: "x".repeat(201), lang: "ja", targetLang: "en" })).toBe("invalid_term");
    expect(await err({ term: "a", lang: "xx", targetLang: "en" })).toBe("invalid_lang");
    expect(await err({ term: "a", lang: "ja", targetLang: "xx" })).toBe("invalid_target");
    expect(await err({ term: "a", lang: "ja", targetLang: "ja" })).toBe("same_lang");
    expect(await err({ term: "a", lang: "ja", targetLang: "en", candidates: Array.from({ length: 21 }, (_, i) => `c${i}`).join("\n") })).toBe("invalid_candidates");
    expect(await err({ term: "a", lang: "ja", targetLang: "en", note: "n".repeat(501) })).toBe("invalid_note");
    expect(await err({ term: "a", lang: "ja", targetLang: "en" })).toBe("ok");
    expect(await err({ term: "a", lang: "ja", targetLang: "en" })).toBe("duplicate");
    expect(await err({ term: "a", lang: "ja", targetLang: "fr" })).toBe("ok");
    const second = await createGlossaryEntry(db, op, { term: "b", lang: "ja", targetLang: "en" });
    if (!second.ok) throw new Error("create failed");
    expect(await updateGlossaryEntry(db, op, second.id, { term: "a", lang: "ja", targetLang: "en" })).toEqual({ ok: false, error: "duplicate" });
  });

  it("keeps a needs-review mark (not yet checked by a speaker of the target language) apart from the content: it can be set and cleared", async () => {
    const db = await setup();
    const created = await createGlossaryEntry(db, op, { term: "alignement", lang: "fr", targetLang: "ja", candidates: "整合性", needsReview: "on" }, { now: t0 });
    if (!created.ok) throw new Error("create failed");
    expect((await listGlossary(db)).entries[0]).toMatchObject({ needsReview: true, keepOriginal: false });
    expect(await updateGlossaryEntry(db, op, created.id, { term: "alignement", lang: "fr", targetLang: "ja", candidates: "整合性" }, { now: t1 })).toEqual({ ok: true, changed: true });
    expect((await listGlossary(db)).entries[0].needsReview).toBe(false);
  });

  it("keeps a term and a candidate to one line: a line break, tab, other control character or line separator is refused (invalid_term, invalid_candidates); a note may have line breaks", async () => {
    const db = await setup();
    const bad = ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u0007b", "a\u007fb", "a\u0085b", "a\u009fb", "a\u2028b", "a\u2029b", "a\r\nb"];
    for (const text of bad) {
      const label = JSON.stringify(text);
      expect(await createGlossaryEntry(db, op, { term: text, lang: "en", targetLang: "ja" }), `term ${label}`).toEqual({ ok: false, error: "invalid_term" });
      // As a line of the textarea (a lone \r, a tab, a separator stay inside the line), and as an array (a file or a crafted post)
      if (!text.includes("\n")) expect(await createGlossaryEntry(db, op, { term: "t", lang: "en", targetLang: "ja", candidates: `ok\n${text}` }), `candidate line ${label}`).toEqual({ ok: false, error: "invalid_candidates" });
      expect(await createGlossaryEntry(db, op, { term: "t", lang: "en", targetLang: "ja", candidates: ["ok", text] }), `candidate ${label}`).toEqual({ ok: false, error: "invalid_candidates" });
    }
    const made = await createGlossaryEntry(db, op, { term: "t", lang: "en", targetLang: "ja", candidates: "x" });
    if (!made.ok) throw new Error("create failed");
    expect(await updateGlossaryEntry(db, op, made.id, { term: "a\nb", candidates: "x" })).toEqual({ ok: false, error: "invalid_term" });
    expect(await updateGlossaryEntry(db, op, made.id, { term: "t", candidates: ["x\ny"] })).toEqual({ ok: false, error: "invalid_candidates" });
    // Spaces inside a term are fine, and a note keeps its line breaks
    expect(await createGlossaryEntry(db, op, { term: "reward  hacking", lang: "en", targetLang: "ja", candidates: ["報酬 ハッキング"], note: "line one\nline two\r\nline three" })).toMatchObject({ ok: true });
    expect((await listGlossary(db)).entries.find((e) => e.term === "reward  hacking")?.note).toBe("line one\nline two\r\nline three");
    // Nothing was written by the refused ones
    expect((await listGlossary(db)).entries.map((e) => e.term).sort()).toEqual(["reward  hacking", "t"]);
  });

  it("parses candidate lines", () => {
    expect(parseCandidates("a\r\n b \n\n a\n")).toEqual(["a", "b"]);
    expect(parseCandidates("")).toEqual([]);
  });
});

describe("glossary version and use in translation", () => {
  it("builds the version from the content of all rows (12 hex characters, null when empty), so that every change including a deletion changes it", async () => {
    const db = await setup();
    expect(await getGlossaryVersion(db)).toBeNull();
    expect(glossaryVersionOf([])).toBeNull();
    const a = await createGlossaryEntry(db, op, { term: "a", lang: "ja", targetLang: "en", candidates: "x" }, { now: t0 });
    if (!a.ok) throw new Error("create failed");
    const v1 = await getGlossaryVersion(db);
    expect(v1).toMatch(/^[0-9a-f]{12}$/);
    const b = await createGlossaryEntry(db, op, { term: "b", lang: "ja", targetLang: "fr" }, { now: t1 });
    if (!b.ok) throw new Error("create failed");
    const v2 = await getGlossaryVersion(db);
    expect(v2).not.toBe(v1);
    // Editing candidates, notes or keep-original changes the version.
    await updateGlossaryEntry(db, op, a.id, { term: "a", lang: "ja", targetLang: "en", candidates: "x\ny" });
    const v3 = await getGlossaryVersion(db);
    expect(v3).not.toBe(v2);
    await updateGlossaryEntry(db, op, a.id, { term: "a", lang: "ja", targetLang: "en", candidates: "x\ny", note: "n" });
    const v4 = await getGlossaryVersion(db);
    expect(v4).not.toBe(v3);
    await updateGlossaryEntry(db, op, a.id, { term: "a", lang: "ja", targetLang: "en", candidates: "x\ny", note: "n", keepOriginal: true });
    const v5 = await getGlossaryVersion(db);
    expect(v5).not.toBe(v4);
    // Candidate order is content too.
    await updateGlossaryEntry(db, op, a.id, { term: "a", lang: "ja", targetLang: "en", candidates: "y\nx", note: "n", keepOriginal: true });
    expect(await getGlossaryVersion(db)).not.toBe(v5);
    // Deletion changes the version too; using maximum updated_at previously missed deletion of a nonlatest row.
    await deleteGlossaryEntry(db, op, b.id);
    const afterDelete = await getGlossaryVersion(db);
    expect(afterDelete).not.toBe(v2);
    await deleteGlossaryEntry(db, op, a.id);
    expect(await getGlossaryVersion(db)).toBeNull();
    // Restoring identical content restores the same version, independent of time and IDs.
    await createGlossaryEntry(db, op, { term: "a", lang: "ja", targetLang: "en", candidates: "x" }, { now: new Date("2027-01-01T00:00:00Z") });
    expect(await getGlossaryVersion(db)).toBe(v1);
  });

  it("does not depend on the order of the rows or on updated_at", () => {
    const row = (term: string, lang = "ja", targetLang = "en") => ({ term, lang, targetLang, candidates: [term], note: "", keepOriginal: false });
    const rows = [row("b"), row("a"), row("a", "ja", "fr"), row("c", "en", "ja")];
    expect(glossaryVersionOf(rows)).toBe(glossaryVersionOf([...rows].reverse()));
    expect(glossaryVersionOf([row("a")])).not.toBe(glossaryVersionOf([row("b")]));
    expect(glossaryVersionOf([{ ...row("a"), candidates: ["x", "y"] }])).not.toBe(glossaryVersionOf([{ ...row("a"), candidates: ["y", "x"] }]));
    // Even injected delimiters cannot make different content share a version.
    expect(glossaryVersionOf([{ ...row("a"), candidates: ["x,y"] }])).not.toBe(glossaryVersionOf([{ ...row("a"), candidates: ["x", "y"] }]));
  });

  it("matches terms case-insensitively as substrings, and carries the note and keep-original flag", () => {
    const rows = [
      { term: "Alignment", candidates: ["整合性"], note: "", keepOriginal: false },
      { term: "RLHF", candidates: [], note: "n", keepOriginal: true },
      { term: "", candidates: ["x"], note: "", keepOriginal: false },
      { term: "absent", candidates: ["x"], note: "", keepOriginal: false },
    ];
    expect(matchGlossary(rows, "about alignment and rlhf")).toEqual([
      { term: "Alignment", candidates: ["整合性"] },
      { term: "RLHF", candidates: [], note: "n", keepOriginal: true },
    ]);
  });

  it("passes the entries a translation needs as suggestions, and stores the version on the translation", async () => {
    const db = await setup();
    await addMember(db, "u1", "hana");
    await createGlossaryEntry(db, op, { term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment" }, { now: t0 });
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "整合性の話" });
    if (!topic.ok) throw new Error("topic failed");
    const reqs: TranslationRequest[] = [];
    const base = createFakeEngine();
    const engine = { ...base, translate: async (req: TranslationRequest) => (reqs.push(req), base.translate(req)) };
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null }, env: {} } }), { now: t1, logger: { error() {}, warn() {} }, limit: 500 });
    expect(reqs.find((r) => r.to === "en" && r.text === "整合性の話")?.glossary).toEqual([{ term: "整合性", candidates: ["alignment"] }]);
    const rows = await db.select().from(translations).where(eq(translations.lang, "en"));
    const version = await getGlossaryVersion(db);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(rows.every((r) => r.glossaryVersion === version)).toBe(true);
    // Deleting a glossary entry after translation leaves the version recorded on that translation.
    for (const entry of (await listGlossary(db)).entries) await deleteGlossaryEntry(db, op, entry.id);
    expect(await getGlossaryVersion(db)).toBeNull();
  });
});
