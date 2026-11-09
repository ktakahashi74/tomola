import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { glossaryEntries, glossaryRevisions, profiles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { canEditGlossary, createGlossaryEntry, deleteGlossaryEntry, listGlossary, listGlossaryRevisions, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { grantModerator, revokeModerator, type ModScope } from "~/lib/roles.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Glossary editors: operators and moderators of the target language can create, update and delete. Moderating the source language grants no permission.
// A zh-Hans moderator cannot edit zh-Hant targets, or vice versa. Server functions check stored rows; hiding forms is not authorization.

const OPERATOR: ModScope = { operator: true, langs: [] };
const mod = (...langs: Array<"ja" | "en" | "zh-Hans" | "zh-Hant">): ModScope => ({ operator: false, langs });
const NONE: ModScope = { operator: false, langs: [] };
const actor = (userId: string, scope: ModScope): GlossaryActor => ({ userId, scope });

describe("canEditGlossary", () => {
  it("is the operator, or a moderator of the target language of the entry, with the same language tag only", () => {
    expect(canEditGlossary(OPERATOR, "ja")).toBe(true);
    expect(canEditGlossary(OPERATOR, "zh-Hant")).toBe(true);
    expect(canEditGlossary(mod("ja"), "ja")).toBe(true);
    expect(canEditGlossary(mod("ja"), "en")).toBe(false);
    expect(canEditGlossary(mod("ja", "en"), "en")).toBe(true);
    // Treat the two scripts as separate languages.
    expect(canEditGlossary(mod("zh-Hans"), "zh-Hant")).toBe(false);
    expect(canEditGlossary(mod("zh-Hant"), "zh-Hans")).toBe(false);
    expect(canEditGlossary(mod("zh-Hans", "zh-Hant"), "zh-Hant")).toBe(true);
    expect(canEditGlossary(NONE, "ja")).toBe(false);
  });
});

let h: RouteHarness;
const saved = process.env.OPERATOR_EMAILS;
let ids: Record<string, string>;
let entry: Record<string, number>;
const entries = () => h.db.select().from(glossaryEntries).orderBy(glossaryEntries.id);
const snapshot = async () => JSON.stringify([await entries(), await h.db.select().from(glossaryRevisions).orderBy(glossaryRevisions.id)]);

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "boss@example.com";
  h = await setupRouteHarness();
  for (const handle of ["boss", "jamod", "hansmod", "hantmod", "plain", "susmod", "exmod", "jamod2"]) await h.signIn(handle);
  ids = h.ids;
  for (const [handle, lang] of [["jamod", "ja"], ["jamod2", "ja"], ["hansmod", "zh-Hans"], ["hantmod", "zh-Hant"], ["susmod", "ja"], ["exmod", "ja"]] as const) {
    const res = await grantModerator(h.db, ids.boss, ids[handle], lang);
    if (!res.ok) throw new Error("grant failed");
  }
  const op = actor(ids.boss, OPERATOR);
  const make = async (key: string, term: string, lang: string, targetLang: string, candidates: string) => {
    const res = await createGlossaryEntry(h.db, op, { term, lang, targetLang, candidates, note: "" });
    if (!res.ok) throw new Error(`create ${key} failed`);
    entry = { ...entry, [key]: res.id };
  };
  entry = {};
  await make("enJa", "alignment", "en", "ja", "アラインメント");
  await make("jaEn", "整合性", "ja", "en", "alignment");
  await make("enHans", "alignment", "en", "zh-Hans", "对齐");
  await make("enHant", "alignment", "en", "zh-Hant", "對齊");
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, ids.susmod));
});
afterAll(() => {
  h.restore();
  if (saved === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = saved;
});

const route = () => import("~/routes/admin-glossary");
const load = async (as: string, query = "") => h.outcome(async () => (await (await route()).loader(h.args(h.request(`/admin/glossary${query}`, { as })))));
const post = async (as: string, form: Record<string, string>) => h.outcome(async () => (await route()).action(h.args(h.request("/admin/glossary", { as, form }))));
const errorOf = (out: { value?: unknown }) => (out.value as { data?: { error?: string } } | undefined)?.data?.error;

describe("the functions check the permission of every write against the saved row", () => {
  it("a moderator of the target language adds, changes and deletes; one of the term language only, or of another language, is refused (forbidden) and nothing is written", async () => {
    const ja = actor(ids.jamod, mod("ja"));
    const before = await snapshot();
    // A Japanese source with an English target is outside a Japanese moderator's scope.
    expect(await updateGlossaryEntry(h.db, ja, entry.jaEn, { term: "整合性", candidates: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteGlossaryEntry(h.db, ja, entry.jaEn)).toEqual({ ok: false, error: "forbidden" });
    expect(await createGlossaryEntry(h.db, ja, { term: "新語", lang: "ja", targetLang: "en", candidates: "new" })).toEqual({ ok: false, error: "forbidden" });
    expect(await createGlossaryEntry(h.db, actor(ids.plain, NONE), { term: "新語", lang: "en", targetLang: "ja", candidates: "new" })).toEqual({ ok: false, error: "forbidden" });
    expect(await snapshot()).toBe(before);
    // Japanese targets allow creation, update and deletion.
    const made = await createGlossaryEntry(h.db, ja, { term: "corrigibility", lang: "en", targetLang: "ja", candidates: "修正可能性" });
    if (!made.ok) throw new Error("create failed");
    expect(await updateGlossaryEntry(h.db, ja, made.id, { term: "corrigibility", candidates: "修正可能性\nコリジビリティ" })).toEqual({ ok: true, changed: true });
    expect(await deleteGlossaryEntry(h.db, ja, made.id)).toEqual({ ok: true });
    const history = (await listGlossaryRevisions(h.db, [made.id])).get(made.id)!;
    expect(history.map((r) => [r.kind, r.editorHandle])).toEqual([["deleted", "jamod"], ["updated", "jamod"], ["created", "jamod"]]);
    // Operators may edit every language.
    const op = actor(ids.boss, OPERATOR);
    expect(await updateGlossaryEntry(h.db, op, entry.jaEn, { term: "整合性", candidates: "alignment\nconsistency" })).toEqual({ ok: true, changed: true });
    expect(await updateGlossaryEntry(h.db, op, entry.jaEn, { term: "整合性", candidates: "alignment" })).toEqual({ ok: true, changed: true });
  });

  it("a Simplified Chinese moderator cannot edit an entry whose target is Traditional Chinese, and the other way round", async () => {
    const hans = actor(ids.hansmod, mod("zh-Hans"));
    const hant = actor(ids.hantmod, mod("zh-Hant"));
    const before = await snapshot();
    expect(await updateGlossaryEntry(h.db, hans, entry.enHant, { term: "alignment", candidates: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteGlossaryEntry(h.db, hans, entry.enHant)).toEqual({ ok: false, error: "forbidden" });
    expect(await createGlossaryEntry(h.db, hans, { term: "x", lang: "en", targetLang: "zh-Hant", candidates: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await updateGlossaryEntry(h.db, hant, entry.enHans, { term: "alignment", candidates: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await createGlossaryEntry(h.db, hant, { term: "x", lang: "en", targetLang: "zh-Hans", candidates: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await snapshot()).toBe(before);
    expect(await updateGlossaryEntry(h.db, hans, entry.enHans, { term: "alignment", candidates: "对齐\n校准" })).toEqual({ ok: true, changed: true });
    expect(await updateGlossaryEntry(h.db, hant, entry.enHant, { term: "alignment", candidates: "對齊\n校準" })).toEqual({ ok: true, changed: true });
    // A moderator appointed to both languages may edit both.
    expect(await updateGlossaryEntry(h.db, actor(ids.hansmod, mod("zh-Hans", "zh-Hant")), entry.enHant, { term: "alignment", candidates: "對齊" })).toEqual({ ok: true, changed: true });
  });

  it("a crafted write cannot move an entry into the scope: a changed language is lang_fixed, and the permission follows the saved target language", async () => {
    const ja = actor(ids.jamod, mod("ja"));
    const before = await snapshot();
    // Submitting an English-target entry with a forged "訳の先は日本語" target is forbidden; authorize against the stored en target.
    expect(await updateGlossaryEntry(h.db, ja, entry.jaEn, { term: "整合性", lang: "ja", targetLang: "ja", candidates: "x" })).toEqual({ ok: false, error: "forbidden" });
    // Changing the target language of one's entry yields lang_fixed.
    expect(await updateGlossaryEntry(h.db, ja, entry.enJa, { term: "alignment", lang: "en", targetLang: "en", candidates: "x" })).toEqual({ ok: false, error: "lang_fixed" });
    expect(await updateGlossaryEntry(h.db, ja, entry.enJa, { term: "alignment", lang: "fr", targetLang: "ja", candidates: "x" })).toEqual({ ok: false, error: "lang_fixed" });
    expect(await snapshot()).toBe(before);
  });
});

describe("/admin/glossary", () => {
  it("is hidden (404) from members who are neither operators nor moderators, for the page and for the form", async () => {
    const before = await snapshot();
    expect(await load("plain")).toMatchObject({ status: 404 });
    expect(await post("plain", { intent: "create", term: "x", lang: "en", targetLang: "ja" })).toMatchObject({ status: 404 });
    expect(await post("plain", { intent: "update", id: String(entry.enJa), term: "alignment", candidates: "x" })).toMatchObject({ status: 404 });
    expect(await post("plain", { intent: "delete", id: String(entry.enJa) })).toMatchObject({ status: 404 });
    expect(await snapshot()).toBe(before);
  });

  it("lists only the entries the moderator can edit, and offers only the languages of the moderator as the target of a new entry; an operator sees all, with nine languages", async () => {
    const mine = (await load("jamod")).value as { entries: Array<{ term: string; targetLang: string }>; targetLangs: string[] };
    expect(mine.entries.map((e) => [e.term, e.targetLang])).toEqual([["alignment", "ja"]]);
    expect(mine.targetLangs).toEqual(["ja"]);
    const hans = (await load("hansmod")).value as { entries: Array<{ targetLang: string }>; targetLangs: string[] };
    expect(hans.entries.map((e) => e.targetLang)).toEqual(["zh-Hans"]);
    const op = (await load("boss")).value as { entries: unknown[]; targetLangs: string[]; langs: string[] };
    expect(op.entries).toHaveLength(4);
    expect(op.targetLangs).toHaveLength(9);
    // Filters remain within the assigned scope.
    expect(((await load("jamod", "?to=en")).value as { entries: unknown[] }).entries).toEqual([]);
    expect(((await load("boss", "?to=en&from=ja")).value as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("a crafted form (an entry outside the scope, a target language outside it, a changed language) is refused with 403 or 400, and nothing changes", async () => {
    const before = await snapshot();
    const outside = await post("jamod", { intent: "update", id: String(entry.jaEn), term: "整合性", candidates: "x" });
    expect(outside).toMatchObject({ status: 403 });
    expect(await post("jamod", { intent: "delete", id: String(entry.jaEn) })).toMatchObject({ status: 403 });
    expect(await post("jamod", { intent: "create", term: "x", lang: "en", targetLang: "fr", candidates: "x" })).toMatchObject({ status: 403 });
    const fixed = await post("jamod", { intent: "update", id: String(entry.enJa), term: "alignment", lang: "en", targetLang: "en", candidates: "x" });
    expect(fixed).toMatchObject({ status: 400 });
    expect(errorOf(fixed)).toBe("lang_fixed");
    expect(await snapshot()).toBe(before);
    // In-scope creation and update succeed; validate the linked source proposal.
    const topic = await createTopic(h.db, ids.plain, { lang: "ja", title: "訳語の提案", body: "b", asksStance: true });
    if (!topic.ok) throw new Error("topic failed");
    const bad = await post("jamod", { intent: "update", id: String(entry.enJa), term: "alignment", candidates: "x", proposal: "https://evil.example/t/1" });
    expect(bad).toMatchObject({ status: 400 });
    expect(errorOf(bad)).toBe("invalid_proposal");
    const ok = await post("jamod", { intent: "update", id: String(entry.enJa), term: "alignment", candidates: "アラインメント\nアライメント", proposal: `/t/${topic.id}`, f_to: "ja", f_page: "1" });
    expect(ok).toMatchObject({ status: 302, location: `/admin/glossary?to=ja#g-${entry.enJa}` });
    const history = (await listGlossaryRevisions(h.db, [entry.enJa])).get(entry.enJa)!;
    expect(history[0]).toMatchObject({ kind: "updated", editorHandle: "jamod", proposalEntryId: topic.id });
    // The entry list shows "最後に変えた人".
    expect((await listGlossary(h.db, { to: "ja" })).entries.find((e) => e.id === entry.enJa)?.updatedByHandle).toBe("jamod");
    // Deletion retains the row but removes it from the active list.
    const created = await post("jamod", { intent: "create", term: "tool use", lang: "en", targetLang: "ja", candidates: "ツール使用" });
    expect(created.status).toBe(302);
    const [added] = (await entries()).filter((e) => e.term === "tool use");
    expect(await post("jamod", { intent: "delete", id: String(added.id) })).toMatchObject({ status: 302, location: "/admin/glossary" });
    expect((await entries()).find((e) => e.id === added.id)?.deletedAt).toBeInstanceOf(Date);
    // Deleting an already-missing entry returns to the list.
    expect(await post("jamod", { intent: "delete", id: String(added.id) })).toMatchObject({ status: 302, location: "/admin/glossary" });
  });

  it("refuses a suspended moderator like anyone who is suspended (the suspension page), for the page and the form", async () => {
    const before = await snapshot();
    expect(await load("susmod")).toMatchObject({ status: 302, location: "/suspended" });
    expect(await post("susmod", { intent: "update", id: String(entry.enJa), term: "alignment", candidates: "x" })).toMatchObject({ status: 302, location: "/suspended" });
    expect(await snapshot()).toBe(before);
  });

  it("stops being usable when the appointment is withdrawn, while the handle in the history of earlier changes stays", async () => {
    const ex = actor(ids.exmod, mod("ja"));
    const made = await createGlossaryEntry(h.db, ex, { term: "reward model", lang: "en", targetLang: "ja", candidates: "報酬モデル" });
    if (!made.ok) throw new Error("create failed");
    expect(await load("exmod")).toMatchObject({ status: 200 });
    expect(await revokeModerator(h.db, ids.exmod, "ja")).toEqual({ ok: true, removed: true });
    expect(await load("exmod")).toMatchObject({ status: 404 });
    expect(await post("exmod", { intent: "update", id: String(made.id), term: "reward model", candidates: "x" })).toMatchObject({ status: 404 });
    // A removed moderator's past history retains their handle because revisions link to the actor's member row.
    const history = (await listGlossaryRevisions(h.db, [made.id])).get(made.id)!;
    expect(history.map((r) => r.editorHandle)).toEqual(["exmod"]);
    expect((await entries()).find((e) => e.id === made.id)?.candidates).toEqual(["報酬モデル"]);
  });
});
