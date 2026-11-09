import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import { distributionViewerFor, readAreaDistributions, readDistributions, summarizeDistribution, toDistribution, type Distribution } from "~/lib/distribution.server";
import type { Area } from "~/lib/languages";
import { buildObservationExport } from "~/lib/exports.server";
import { createTopic, softDeleteEntry } from "~/lib/entries.server";
import { hideEntry, unhideEntry, type Actor } from "~/lib/moderation.server";
import { signOpenInAiToken } from "~/lib/open-in-ai.server";
import { getProfile } from "~/lib/profiles.server";
import { grantModerator } from "~/lib/roles.server";
import { setStance } from "~/lib/stances.server";
import { createApiToken } from "~/lib/tokens.server";
import { addMember, createTestDb } from "./helpers/db";
import { getMd, parseBlocks } from "./helpers/md";
import { findStanceTableUses, productionSources, type StanceTable } from "./helpers/stance-reader-scan";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Stance distributions: totals and language participation only. Per-language counts come only from operator readAreaDistributions.
// UI loaders, /stance and stances.md routes are covered later (tests/stance-routes.test.ts).
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const OP: Actor = { id: "op", scope: { operator: true, langs: [] } };
const OBSERVATION = { kind: "observation" } as const;

describe("summarizeDistribution (the pure part)", () => {
  const asOf = t(0);
  const row = (area: Area, position: "agree" | "disagree" | "neither", count: number) => ({ area, position, count });

  it("counts the totals, the number of people and the number of languages", () => {
    // Zero people.
    expect(summarizeDistribution(1, [], asOf)).toEqual({ questionId: 1, total: 0, counts: { agree: 0, disagree: 0, neither: 0 }, langs: 0, asOf, byArea: [] });
    // One language, one person.
    expect(summarizeDistribution(1, [row("ja", "agree", 1)], asOf)).toMatchObject({ total: 1, counts: { agree: 1, disagree: 0, neither: 0 }, langs: 1 });
    // Multiple languages: totals span languages; count the language areas with people.
    const many = summarizeDistribution(1, [row("ja", "agree", 3), row("ja", "disagree", 1), row("en", "agree", 2), row("fr", "neither", 1)], asOf);
    expect(many).toMatchObject({ total: 7, counts: { agree: 5, disagree: 1, neither: 1 }, langs: 3 });
    expect(many.byArea).toEqual([
      { area: "ja", agree: 3, disagree: 1, neither: 0 },
      { area: "en", agree: 2, disagree: 0, neither: 0 },
      { area: "fr", agree: 0, disagree: 0, neither: 1 },
    ]);
    // People from the same language choosing different stances still count as one language.
    expect(summarizeDistribution(1, [row("ja", "agree", 2), row("ja", "disagree", 2), row("ja", "neither", 2)], asOf)).toMatchObject({ total: 6, langs: 1 });
    // "その他" counts as one language; Simplified and Traditional count separately.
    expect(summarizeDistribution(1, [row("other", "agree", 4), row("zh-Hans", "agree", 1), row("zh-Hant", "agree", 1)], asOf)).toMatchObject({ total: 6, langs: 3 });
    // Zero-person rows do not count toward languages.
    expect(summarizeDistribution(1, [row("ja", "agree", 0), row("en", "agree", 1)], asOf)).toMatchObject({ total: 1, langs: 1 });
  });

  it("toDistribution builds a new object with five fields only: no byArea, no language tags", () => {
    const detailed = summarizeDistribution(9, [row("ja", "agree", 3), row("en", "disagree", 2)], asOf);
    const shown = toDistribution(detailed);
    expect(Object.keys(shown).sort()).toEqual(["asOf", "counts", "langs", "questionId", "total"]);
    expect(Object.keys(shown.counts).sort()).toEqual(["agree", "disagree", "neither"]);
    expect(shown).toEqual({ questionId: 9, total: 5, counts: { agree: 3, disagree: 2, neither: 0 }, langs: 2, asOf });
    // Mutating the internal source shape leaves the display shape unchanged; counts is a new object.
    detailed.counts.agree = 99;
    expect(shown.counts.agree).toBe(3);
  });
});

// Author author; stance members ann1/ann2/ann3 (ja), bob1/bob2 (en), cid (fr), kim (other); operator op.
async function world() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { homeArea: "ja" });
  for (const id of ["ann1", "ann2", "ann3"]) await addMember(db, id, id, { homeArea: "ja" });
  for (const id of ["bob1", "bob2"]) await addMember(db, id, id, { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "cid", "cid", { homeArea: "fr", readLangs: ["fr"] });
  await addMember(db, "kim", "kim", { homeArea: "other", readLangs: ["en"] });
  await addMember(db, "op", "opr", { homeArea: "ja" });
  const q = await createTopic(db, "author", { lang: "ja", title: "問い", body: "命題です。", asksStance: true }, { now: t(0) });
  if (!q.ok) throw new Error("question failed");
  return { db, q: q.id };
}
const choose = async (db: Db, userId: string, questionId: number, position: "agree" | "disagree" | "neither", minute = 1) => {
  const res = await setStance(db, userId, { questionId, position, expectedVersion: 0 }, { now: t(minute) });
  if (!res.ok) throw new Error(`stance failed: ${res.error}`);
};
const member = async (db: Db, userId: string) => ({ userId, profile: (await getProfile(db, userId))! });

describe("readDistributions", () => {
  it("returns the totals and the number of languages, in the same shape for one person and for one language (no gating by headcount)", async () => {
    const { db, q } = await world();
    const viewer = distributionViewerFor(await member(db, "ann1"));
    expect(viewer).toEqual({ kind: "member", userId: "ann1" });
    const asOf = t(60);
    // Zero people.
    expect((await readDistributions(db, [q], viewer, { now: asOf })).get(q)).toEqual({ questionId: q, total: 0, counts: { agree: 0, disagree: 0, neither: 0 }, langs: 0, asOf });
    // One person, one language: same returned shape.
    await choose(db, "ann1", q, "agree");
    expect((await readDistributions(db, [q], viewer, { now: asOf })).get(q)).toEqual({ questionId: q, total: 1, counts: { agree: 1, disagree: 0, neither: 0 }, langs: 1, asOf });
    // Three languages plus other: ja has 3 people, en 2, fr 1, other 1. Return totals and four language areas (ja, en, fr, other).
    await choose(db, "ann2", q, "agree");
    await choose(db, "ann3", q, "disagree");
    await choose(db, "bob1", q, "agree");
    await choose(db, "bob2", q, "neither");
    await choose(db, "cid", q, "disagree");
    await choose(db, "kim", q, "agree");
    const shown = (await readDistributions(db, [q], viewer, { now: asOf })).get(q) as Distribution;
    expect(shown).toEqual({ questionId: q, total: 7, counts: { agree: 4, disagree: 2, neither: 1 }, langs: 4, asOf });
    expect(Object.keys(shown).sort()).toEqual(["asOf", "counts", "langs", "questionId", "total"]);
    // Observation viewers receive the same display shape.
    expect(await readDistributions(db, [q], OBSERVATION, { now: asOf })).toEqual(new Map([[q, shown]]));
  });

  it("does not count a member under exclude_reactions, in the total or in the number of languages; a suspended member counts", async () => {
    const { db, q } = await world();
    await choose(db, "ann1", q, "agree");
    await choose(db, "bob1", q, "disagree");
    await choose(db, "cid", q, "neither");
    const read = async () => (await readDistributions(db, [q], OBSERVATION)).get(q) as Distribution;
    expect(await read()).toMatchObject({ total: 3, langs: 3 });
    // Excluding the only person in an area decreases the language count by one.
    await db.update(profiles).set({ reactionsExcludedAt: t(5) }).where(eq(profiles.userId, "cid"));
    expect(await read()).toMatchObject({ total: 2, counts: { agree: 1, disagree: 1, neither: 0 }, langs: 2 });
    // Exclusion also affects stances predating the action; reversing it restores all of them.
    await db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "cid"));
    expect(await read()).toMatchObject({ total: 3, langs: 3 });
    // Count suspended members' stances.
    await db.update(profiles).set({ suspendedUntil: new Date(Date.UTC(2031, 0, 1)), suspendedReason: "spam" }).where(eq(profiles.userId, "bob1"));
    expect(await read()).toMatchObject({ total: 3, langs: 3 });
  });

  it("leaves out ids that are not live questions: deleted, hidden, and topics that are not questions (it removes them itself)", async () => {
    const { db, q } = await world();
    const hidden = await createTopic(db, "author", { lang: "ja", title: "隠す問い", body: "命題です。", asksStance: true });
    const deleted = await createTopic(db, "author", { lang: "ja", title: "消す問い", body: "命題です。", asksStance: true });
    const plain = await createTopic(db, "author", { lang: "ja", title: "ふつうの話題", body: "本文です。" });
    if (!hidden.ok || !deleted.ok || !plain.ok) throw new Error("setup failed");
    for (const id of [q, hidden.id, deleted.id]) await choose(db, "ann1", id, "agree");
    await hideEntry(db, OP, { entryId: hidden.id, reason: "spam", note: "x" }, { now: t(10) });
    await softDeleteEntry(db, deleted.id, { now: t(11) });
    const ids = [q, hidden.id, deleted.id, plain.id, 999_999];
    for (const viewer of [distributionViewerFor(await member(db, "ann1")), OBSERVATION]) {
      expect([...(await readDistributions(db, ids, viewer)).keys()]).toEqual([q]);
    }
    expect([...(await readAreaDistributions(db, ids, OBSERVATION)).keys()]).toEqual([q]);
    // Unhiding exposes it again because stance rows remain. Undoing deletion restores it by clearing deleted_at.
    await unhideEntry(db, OP, { entryId: hidden.id, reason: "other" }, { now: t(12) });
    expect([...(await readDistributions(db, ids, OBSERVATION)).keys()].sort()).toEqual([q, hidden.id].sort());
    await db.update(entries).set({ deletedAt: null }).where(eq(entries.id, deleted.id));
    expect([...(await readDistributions(db, ids, OBSERVATION)).keys()].sort()).toEqual([q, hidden.id, deleted.id].sort());
    // Empty input gives empty output.
    expect((await readDistributions(db, [], OBSERVATION)).size).toBe(0);
  });
});

describe("the observation export", () => {
  it("lists the readable questions with the display shape of the distribution only (no per-area numbers, no changes, no individual stance), and leaves out hidden and deleted ones", async () => {
    const { db, q } = await world();
    const hidden = await createTopic(db, "author", { lang: "ja", title: "隠す問い", body: "命題です。", asksStance: true });
    const deleted = await createTopic(db, "author", { lang: "ja", title: "消す問い", body: "命題です。", asksStance: true });
    const plain = await createTopic(db, "author", { lang: "ja", title: "ふつうの話題", body: "本文です。" });
    if (!hidden.ok || !deleted.ok || !plain.ok) throw new Error("setup failed");
    for (const id of [q, hidden.id, deleted.id]) {
      await choose(db, "ann1", id, "agree");
      await choose(db, "bob1", id, "agree");
      await choose(db, "cid", id, "neither");
    }
    await hideEntry(db, OP, { entryId: hidden.id, reason: "spam", note: "x" }, { now: t(10) });
    await softDeleteEntry(db, deleted.id, { now: t(11) });
    const out = await buildObservationExport(db, { model: null, now: t(60), salt: Buffer.alloc(32, 1) });
    expect(out.questions).toEqual([{ id: q, alt_of: null, created_at: t(0).toISOString(), distribution: { total: 3, counts: { agree: 2, disagree: 0, neither: 1 }, langs: 3, as_of: t(60).toISOString() } }]);
    // No language-area-keyed fields, personal stances or change records anywhere in the question.
    const text = JSON.stringify(out.questions);
    expect(text).not.toMatch(/"(?:ja|en|fr|other|byArea|by_area|composition|user|userId|position)"/);
    expect(text).not.toMatch(/ann1|bob1|cid/);
    expect((out as unknown as Record<string, unknown>).stance_changes).toBeUndefined();
    // Do not count excluded members' stances.
    await db.update(profiles).set({ reactionsExcludedAt: t(20) }).where(eq(profiles.userId, "cid"));
    expect((await buildObservationExport(db, { model: null, now: t(61), salt: Buffer.alloc(32, 1) })).questions[0].distribution).toMatchObject({ total: 2, langs: 2 });
  });
});

describe("readAreaDistributions (the operator-only reader)", () => {
  it("has the same totals and number of languages as readDistributions, and the languages add up to the total", async () => {
    const { db, q } = await world();
    for (const [id, position] of [["ann1", "agree"], ["ann2", "agree"], ["bob1", "disagree"], ["cid", "neither"], ["kim", "agree"]] as const) await choose(db, id, q, position);
    const asOf = t(60);
    const [plain, detailed] = await Promise.all([readDistributions(db, [q], OBSERVATION, { now: asOf }), readAreaDistributions(db, [q], OBSERVATION, { now: asOf })]);
    const d = detailed.get(q)!;
    expect(toDistribution(d)).toEqual(plain.get(q));
    expect(d.byArea).toEqual([
      { area: "ja", agree: 2, disagree: 0, neither: 0 },
      { area: "en", agree: 0, disagree: 1, neither: 0 },
      { area: "fr", agree: 0, disagree: 0, neither: 1 },
      { area: "other", agree: 1, disagree: 0, neither: 0 },
    ]);
    expect(d.byArea.reduce((n, a) => n + a.agree + a.disagree + a.neither, 0)).toBe(d.total);
    expect(d.byArea).toHaveLength(d.langs);
  });
});

describe("the one reader (the source is scanned)", () => {
  const appDir = path.join(process.cwd(), "app");
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "paraglide" ? [] : files(path.join(dir, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join("/");
  const sources = files(appDir).map((f) => ({ file: rel(f), text: fs.readFileSync(f, "utf8") }));

  // Who may touch which stance table. The tables are read in a few places only: the schema (definitions), stances.server.ts (a member's own rows and their history; the only
  // place that writes), distribution.server.ts (the one reader that counts stances), exports.server.ts (the member export: the member's own rows, selected by the member's id)
  // and metrics.server.ts (operator metrics: stance_changes only, counted across questions and never per question).
  const READERS: Record<string, readonly StanceTable[]> = {
    "app/lib/db/schema.ts": ["stances", "stanceChanges"],
    "app/lib/stances.server.ts": ["stances", "stanceChanges"],
    "app/lib/distribution.server.ts": ["stances"],
    "app/lib/exports.server.ts": ["stances", "stanceChanges"],
    "app/lib/metrics.server.ts": ["stanceChanges"],
  };

  it("only distribution.server.ts counts the stances, and stance_changes is touched only by the schema, stances.server.ts, the member export and the operator metrics: no import of the tables, no schema.stances, no .query.stances, no raw SQL elsewhere", () => {
    const scanned = productionSources();
    const offenders = scanned.flatMap(({ file, text }) => {
      const { tables, reasons } = findStanceTableUses(text);
      const allowed = READERS[file] ?? [];
      return [...tables].filter((table) => !allowed.includes(table)).map((table) => `${file}: ${table} (${reasons.filter((r) => r.startsWith(`${table}:`)).join("; ")})`);
    });
    expect(offenders).toEqual([]);
    // The scan is not empty: it reads the application, and finds the tables where they are used (so a silent detector would fail here, not pass)
    expect(scanned.length).toBeGreaterThan(100);
    const usesOf = (file: string) => findStanceTableUses(scanned.find((s) => s.file === file)!.text).tables;
    expect([...usesOf("app/lib/distribution.server.ts")]).toEqual(["stances"]);
    expect([...usesOf("app/lib/stances.server.ts")].sort()).toEqual(["stanceChanges", "stances"]);
    // Taking the allowance away makes the real files offenders (the allowed files really are the readers)
    for (const [file, tables] of Object.entries(READERS)) {
      if (file === "app/lib/db/schema.ts") continue; // table definitions: `export const stances = pgTable(...)`, not a use by this scan
      for (const table of tables) expect(usesOf(file).has(table), `${file} uses ${table}`).toBe(true);
    }
    // The member-facing files do not read them. The member export reads the member's own rows only, and the metrics read stance_changes only (never the table of the current stances)
    expect([...usesOf("app/lib/exports.server.ts")].sort()).toEqual(["stanceChanges", "stances"]);
    expect([...usesOf("app/lib/metrics.server.ts")]).toEqual(["stanceChanges"]);
    for (const file of ["app/lib/topic-list.server.ts", "app/routes/topic.tsx", "app/routes/stance.ts", "app/routes/stances-md.ts", "app/lib/profiles.server.ts"]) {
      expect(scanned.some((s) => s.file === file), `${file} exists`).toBe(true);
      expect([...usesOf(file)], file).toEqual([]);
    }
  });

  it("nothing but distribution.server.ts itself mentions readAreaDistributions and AreaDistribution: no screen (app/routes), not the operator pages either, and no member path", () => {
    const allowed = /^app\/lib\/distribution\.server\.ts$/;
    const users = sources.filter(({ text }) => /\b(?:readAreaDistributions|AreaDistribution)\b/.test(text));
    expect(users.map((u) => u.file).filter((f) => !allowed.test(f))).toEqual([]);
    expect(users.map((u) => u.file)).toContain("app/lib/distribution.server.ts");
    // Member-facing routes.
    for (const f of ["app/routes/topic.tsx", "app/routes/home.tsx", "app/routes/latest.tsx", "app/routes/area.tsx", "app/lib/topic-list.server.ts", "app/lib/exports.server.ts", "app/lib/metrics.server.ts"]) {
      const text = sources.find((s) => s.file === f)?.text;
      if (text !== undefined) expect(text, f).not.toMatch(/readAreaDistributions|AreaDistribution/);
    }
  });

  it("has no threshold setting for showing languages, and no composition of languages", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/STANCE_AREA_MIN/);
      expect(text.replace(/\/\/.*$/gm, ""), file).not.toMatch(/\bcomposition\b/);
    }
    // byArea exists only in distribution.server.ts's internal shape.
    expect(sources.filter(({ text }) => /\bbyArea\b/.test(text)).map((s) => s.file)).toEqual(["app/lib/distribution.server.ts"]);
    expect(sources.filter(({ text }) => /\bby_area\b/.test(text)).map((s) => s.file).filter((f) => f !== "app/lib/exports.server.ts")).toEqual([]);
  });
});

describe("the detector behind that scan (synthetic sources)", () => {
  const uses = (source: string) => [...findStanceTableUses(source).tables].sort();

  it("finds a named import of either table from the schema module, however the specifier is written", () => {
    const specifiers = ["~/lib/db/schema", "../lib/db/schema", "../../app/lib/db/schema", "./schema", "../db/schema.ts", "~/lib/db/schema.js", "./db/schema.mjs", "../lib/db/schema.tsx"];
    for (const specifier of specifiers) {
      expect(uses(`import { stances } from "${specifier}";`), specifier).toEqual(["stances"]);
      expect(uses(`import { entries, stanceChanges } from '${specifier}';`), specifier).toEqual(["stanceChanges"]);
    }
    // aliases, type imports, several lines, both tables, a re-export
    expect(uses(`import { stances as s } from "~/lib/db/schema";`)).toEqual(["stances"]);
    expect(uses(`import type { stanceChanges } from "~/lib/db/schema";`)).toEqual(["stanceChanges"]);
    expect(uses(`import { type stances, entries } from "~/lib/db/schema";`)).toEqual(["stances"]);
    expect(uses(`import {\n  entries,\n  profiles,\n  stanceChanges,\n  stances,\n} from "~/lib/db/schema";`)).toEqual(["stanceChanges", "stances"]);
    expect(uses(`export { stances } from "~/lib/db/schema";`)).toEqual(["stances"]);
    expect(uses(`export { stanceChanges as changes } from "../db/schema";`)).toEqual(["stanceChanges"]);
  });

  it("finds a namespace import used as ns.stances, schema.stances, db.query.stances, a destructuring, and a dynamic import of the schema", () => {
    expect(uses(`import * as tables from "~/lib/db/schema";\nconst rows = await db.select().from(tables.stanceChanges);`)).toEqual(["stanceChanges"]);
    expect(uses(`import * as s from "../lib/db/schema.ts";\nawait db.select().from(s.stances);`)).toEqual(["stances"]);
    expect(uses(`const rows = await db.select().from(schema.stances);`)).toEqual(["stances"]);
    expect(uses(`const rows = await db.select().from(schema.stanceChanges);`)).toEqual(["stanceChanges"]);
    expect(uses(`const rows = await db.query.stances.findMany();`)).toEqual(["stances"]);
    expect(uses(`const rows = await tx.query.stanceChanges.findMany({ where });`)).toEqual(["stanceChanges"]);
    expect(uses(`import * as t from "~/lib/db/schema";\nconst { stances, entries } = t;`)).toEqual(["stances"]);
    // a dynamic import cannot be read: it counts as both
    expect(uses(`const { stances } = await import("~/lib/db/schema");`)).toEqual(["stanceChanges", "stances"]);
    expect(uses(`const schema = require("../db/schema.js");`)).toEqual(["stanceChanges", "stances"]);
  });

  it("finds raw SQL that mentions stance_changes or stances", () => {
    expect(uses("const rows = await db.execute(sql`select count(*) from stance_changes`);")).toEqual(["stanceChanges"]);
    expect(uses(`await db.execute("DELETE FROM stance_changes WHERE user_id = $1");`)).toEqual(["stanceChanges"]);
    expect(uses("await db.execute(sql`select * from stances where question_id = ${q}`);")).toEqual(["stances"]);
    expect(uses(`await pool.query("select position, count(*) from public.stances group by position");`)).toEqual(["stances"]);
    expect(uses(`await pool.query('insert into "stances" (user_id) values ($1)');`)).toEqual(["stances"]);
    expect(uses("sql`select s.position from stance_changes sc join stances s on s.user_id = sc.user_id`")).toEqual(["stanceChanges", "stances"]);
    expect(uses("sql`select e.id from entries e, stances s where s.question_id = e.id`")).toEqual(["stances"]);
    expect(uses('sql`select e.id from "entries" as e, profiles p, "public"."stances" as s where s.question_id = e.id`')).toEqual(["stances"]);
    expect(uses(`await pool.query("truncate table stances");`)).toEqual(["stances"]);
    expect(uses(`await pool.query("update stances set position = 'agree'");`)).toEqual(["stances"]);
    expect(uses(`await pool.query('insert into "public"."stance_changes" (user_id) values ($1)');`)).toEqual(["stanceChanges"]);
    expect(uses(`await pool.query("truncate table stance_changes");`)).toEqual(["stanceChanges"]);
    expect(uses(`await pool.query("update only public.stance_changes set area = 'ja'");`)).toEqual(["stanceChanges"]);
    expect(uses('sql`select e.id from "entries" as e, profiles p, "public"."stance_changes" as sc where sc.question_id = e.id`')).toEqual(["stanceChanges"]);
  });

  it("does not take a comment, ordinary words, a different table or a different file for a use", () => {
    expect(uses(`// import { stances } from "~/lib/db/schema"; stance_changes\nconst a = 1;`)).toEqual([]);
    expect(uses(`/* schema.stances and db.query.stanceChanges */\nconst a = 1;`)).toEqual([]);
    expect(uses(`/**\n * select * from stance_changes\n */\nexport const a = 1;`)).toEqual([]);
    expect(uses(`const label = "People's stances are anonymous";\nconst other = "Your stances and their history";`)).toEqual([]);
    expect(uses("const guide = `Distribution of the stances on a question, from how many languages the members come; update the stances page`;")).toEqual([]);
    expect(uses('const guide = "from how many languages the members come. Lists show Insightful, stances and replies";')).toEqual([]);
    expect(uses('const guide = "The private export has the member\'s own insightful, stances, stance_changes and follows; the browser session is required.";')).toEqual([]);
    expect(uses("const guide = `Download from /settings/export: your stances, stance_changes and follows. No other member's rows are included.`;")).toEqual([]);
    expect(uses(`const path = "/t/:id/stances.md"; const url = "https://example.com/stances";`)).toEqual([]);
    expect(uses(`import { entries, profiles, votes } from "~/lib/db/schema";\nawait db.select().from(votes);`)).toEqual([]);
    expect(uses(`import { stances } from "~/lib/stances";`)).toEqual([]);
    expect(uses(`import { stances } from "~/lib/something-schema";`)).toEqual([]);
    expect(uses(`import * as schema from "./schema";\nconst db = drizzle({ client, schema });`)).toEqual([]);
    expect(uses(`const stances = loadOwnStances(); return stances.length;`)).toEqual([]);
  });
});

// ---- Across route loaders/actions and Markdown twins: identical distribution counts and shapes for everyone, with no distributions for deleted or hidden questions ----
describe("through every path of the application (the route harness)", () => {
  let h: RouteHarness;
  const savedOperators = process.env.OPERATOR_EMAILS;
  const BASE_DATE = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "operator-dist@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("ann", { homeArea: "ja" });
    await h.signIn("bob", { homeArea: "en", readLangs: ["en", "ja"] });
    await h.signIn("cid", { homeArea: "fr", readLangs: ["fr", "ja"] });
    await h.signIn("jamod", { homeArea: "ja" });
    await h.signIn("opal", { homeArea: "ja", email: "operator-dist@example.com" });
    await h.signIn("halfway", { profile: false });
    expect((await grantModerator(h.db, h.ids.opal, h.ids.jamod, "ja")).ok).toBe(true);
  });
  afterAll(() => {
    h.restore();
    if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = savedOperators;
  });

  const loadRoute = async (name: "topic" | "latest" | "home" | "area", as: string, path: string, params: Record<string, string> = {}) => {
    const mod = (await import(`../app/routes/${name}.tsx`)) as { loader: (a: never) => unknown };
    return (await mod.loader(h.args(h.request(path, { as }), params))) as Record<string, unknown>;
  };
  const stanceAction = async (as: string, form: Record<string, string>, headers: Record<string, string> = { "sec-fetch-dest": "empty" }) => {
    const mod = await import("~/routes/stance");
    return h.outcome(() => mod.action(h.args(h.request("/stance", { as, form, headers }))));
  };
  const question = async (title: string) => {
    const res = await createTopic(h.db, h.ids.hana, { lang: "ja", title, body: "命題です。", asksStance: true }, { now: BASE_DATE(0) });
    if (!res.ok) throw new Error("question failed");
    return res.id;
  };
  const choose = async (as: string, q: number, position: "agree" | "disagree" | "neither") => {
    const res = await setStance(h.db, h.ids[as], { questionId: q, position, expectedVersion: 0 }, { now: BASE_DATE(1) });
    if (!res.ok) throw new Error(`stance failed: ${res.error}`);
  };
  type Item = { id: number; stance?: { position: string | null; version: number }; distribution?: { total: number; langs: number } | null };
  const itemOf = (loaderData: Record<string, unknown>, id: number): Item | undefined => ((loaderData.topics ?? loaderData.topics) as Item[]).find((t) => t.id === id);
  const stancesMd = async (as: string, id: number, suffix: "md" | "txt" = "md") => getMd(h, `/t/${id}/stances.${suffix}`, { as });

  it("is not in the data of the page or the list before the member chose, comes with ?peek=, and is in once the member chose; the same numbers on every path", async () => {
    const q = await question("経路の問い");
    for (const [who, position] of [["ann", "agree"], ["bob", "agree"], ["cid", "disagree"]] as const) await choose(who, q, position);
    // A member without a stance (author hana) gets no distribution unless ?peek=1 or ?peek=<id> is requested.
    const before = await loadRoute("topic", "hana", `/t/${q}`, { id: String(q) });
    expect((before.question as { stance: { distribution: unknown } }).stance.distribution).toBeNull();
    const peeked = await loadRoute("topic", "hana", `/t/${q}?peek=1`, { id: String(q) });
    expect((peeked.question as { stance: { distribution: unknown } }).stance.distribution).toMatchObject({ questionId: q, total: 3, counts: { agree: 2, disagree: 1, neither: 0 }, langs: 3 });
    expect(itemOf(await loadRoute("latest", "hana", "/latest"), q)).toMatchObject({ stance: { position: null, version: 0 }, distribution: null });
    expect(itemOf(await loadRoute("latest", "hana", `/latest?peek=${q}`), q)).toMatchObject({ distribution: { total: 3, langs: 3 } });
    // A different question's ?peek= does not affect this question.
    expect(itemOf(await loadRoute("latest", "hana", `/latest?peek=${q + 1}`), q)?.distribution).toBeNull();
    // Members who chose a stance receive the distribution automatically, with identical counts on the question, list, /stance response and stances.md.
    const asAnn = await loadRoute("topic", "ann", `/t/${q}`, { id: String(q) });
    expect((asAnn.question as { stance: { stance: unknown; distribution: unknown } }).stance).toMatchObject({ stance: { position: "agree", version: 1 }, distribution: { total: 3, counts: { agree: 2, disagree: 1, neither: 0 }, langs: 3 } });
    expect(itemOf(await loadRoute("latest", "ann", "/latest"), q)).toMatchObject({ stance: { position: "agree", version: 1 }, distribution: { total: 3, langs: 3 } });
    const sent = await stanceAction("ann", { questionId: String(q), position: "agree", version: "1" });
    expect(sent.status).toBe(200);
    expect((sent.value as { data: { distribution: unknown } }).data.distribution).toMatchObject({ total: 3, counts: { agree: 2, disagree: 1, neither: 0 }, langs: 3 });
    const md = await stancesMd("hana", q);
    expect(md.status).toBe(200);
    const [block] = parseBlocks(await md.text());
    expect(block.fm).toMatchObject({ type: "stances", question: `p-${q}`, total: 3, counts: { agree: 2, disagree: 1, neither: 0 }, total_langs: 3 });
    // List Markdown and question lists (language-area pages and home) show the same counts.
    expect(itemOf(await loadRoute("area", "ann", "/a/ja", { lang: "ja" }), q)).toMatchObject({ distribution: { total: 3 } });
    const home = (await loadRoute("home", "ann", "/")) as { topics: Item[] };
    expect(home.topics.find((t) => t.id === q)).toMatchObject({ distribution: { total: 3, langs: 3 } });
  });

  it("never gives the distribution of a hidden or a deleted question: not through direct reads, the lists, the page, /stance or stances.md; it is back after the question is shown again or restored", async () => {
    const hidden = await question("隠す問い");
    const deleted = await question("消す問い");
    const plain = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "ふつうの話題", body: "本文" });
    if (!plain.ok) throw new Error("topic failed");
    for (const id of [hidden, deleted]) {
      await choose("ann", id, "agree");
      await choose("bob", id, "disagree");
    }
    const op = { id: h.ids.opal, scope: { operator: true, langs: [] } } as Actor;
    expect((await hideEntry(h.db, op, { entryId: hidden, reason: "spam", note: "x" }, { now: BASE_DATE(10) })).ok).toBe(true);
    expect((await softDeleteEntry(h.db, deleted, { now: BASE_DATE(11) })).ok).toBe(true);
    // (1) Direct reads omit it from the Map for members and observation; also omit non-question topics.
    for (const viewer of [{ kind: "member", userId: h.ids.ann }, OBSERVATION] as const) expect([...(await readDistributions(h.db, [hidden, deleted, plain.id], viewer)).keys()]).toEqual([]);
    // (2) Even ?peek=<id> does not expose distributions in lists that include hidden posts for the author, responsible moderator or operator.
    for (const as of ["hana", "jamod", "opal"]) {
      const list = await loadRoute("latest", as, `/latest?peek=${hidden}`);
      expect(itemOf(list, hidden), as).toBeDefined();
      expect(itemOf(list, hidden)?.distribution, as).toBeNull();
      expect(itemOf(await loadRoute("latest", as, `/latest?peek=${deleted}`), deleted), as).toBeUndefined();
    }
    // The list for ann, who already chose a stance, also hides the distribution: the stance row exists but the question is hidden.
    expect(itemOf(await loadRoute("latest", "ann", "/latest"), hidden)).toBeUndefined();
    // (3) Hidden-question pages for the author, responsible moderator and operator expose no distribution even with ?peek=1 and forbid choosing.
    for (const as of ["hana", "jamod", "opal"]) {
      const page = await loadRoute("topic", as, `/t/${hidden}?peek=1`, { id: String(hidden) });
      expect(page.question as object, as).toMatchObject({ stance: { distribution: null, canChoose: false } });
      // a distribution has `counts` (the Insightful state of a post has a "total" too, so the distribution is recognised by its counts)
      expect(JSON.stringify(page)).not.toMatch(/"counts":/);
    }
    // (4) /stance withdrawal responses for hidden questions omit distribution. Registration and changes return 404 hidden.
    expect((await stanceAction("ann", { questionId: String(hidden), position: "agree", version: "1" })).status).toBe(404);
    const withdrawn = await stanceAction("ann", { questionId: String(hidden), position: "none", version: "1" });
    expect(withdrawn.status).toBe(200);
    expect((withdrawn.value as { data: { position: unknown; distribution: unknown } }).data).toMatchObject({ ok: true, position: null, distribution: null });
    // (5) stances.md returns only hidden: true for hidden questions, without totals or language counts. Deleted questions and non-question topics return 404.
    const hiddenMd = await stancesMd("ann", hidden);
    expect(hiddenMd.status).toBe(200);
    const hiddenText = await hiddenMd.text();
    expect(parseBlocks(hiddenText)[0].fm).toMatchObject({ type: "stances", question: `p-${hidden}`, hidden: true });
    expect(hiddenText).not.toMatch(/total|counts|agree|disagree/);
    for (const id of [deleted, plain.id, 999_999]) expect((await stancesMd("ann", id)).status, String(id)).toBe(404);
    // (7) Unhiding or restoration makes the distribution available again through the same routes.
    expect((await unhideEntry(h.db, op, { entryId: hidden, reason: "other" }, { now: BASE_DATE(12) })).ok).toBe(true);
    await h.db.update(entries).set({ deletedAt: null }).where(eq(entries.id, deleted));
    expect((await readDistributions(h.db, [hidden, deleted], OBSERVATION)).get(deleted)).toMatchObject({ total: 2 });
    expect((await readDistributions(h.db, [hidden], OBSERVATION)).get(hidden)).toMatchObject({ total: 1 });
    expect(parseBlocks(await (await stancesMd("bob", hidden)).text())[0].fm).toMatchObject({ total: 1, total_langs: 1 });
    expect(parseBlocks(await (await stancesMd("bob", deleted)).text())[0].fm).toMatchObject({ total: 2, total_langs: 2 });
  });

  it("is only for active members: stances.md refuses visitors (401) and a user mid-signup (403); the answer is private and not stored; the page needs a member", async () => {
    const q = await question("会員だけの問い");
    await choose("ann", q, "agree");
    const visitor = await stancesMd("", q);
    expect(visitor.status).toBe(401);
    expect(await visitor.text()).not.toContain("total");
    expect((await stancesMd("halfway", q)).status).toBe(403);
    const ok = await stancesMd("bob", q);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("content-type")).toContain("text/plain");
    // Read tokens and signed links for active members can read it; draft tokens cannot.
    const read = await createApiToken(h.db, h.ids.bob, { name: "reader", kind: "read" });
    const draft = await createApiToken(h.db, h.ids.bob, { name: "drafter", kind: "draft" });
    if (!read.ok || !draft.ok) throw new Error("token failed");
    expect((await getMd(h, `/t/${q}/stances.md`, { headers: { authorization: `Bearer ${read.token}` } })).status).toBe(200);
    expect((await getMd(h, `/t/${q}/stances.md?k=${signOpenInAiToken({ resource: `/t/${q}/stances.md`, userId: h.ids.bob, generation: 0 })}`)).status).toBe(200);
    expect((await getMd(h, `/t/${q}/stances.md`, { headers: { authorization: `Bearer ${draft.token}` } })).status).toBe(403);
    // .txt has identical content.
    const withoutTime = (text: string) => text.replace(/^as_of: .*$/m, "as_of");
    expect(withoutTime(await (await stancesMd("bob", q, "txt")).text())).toBe(withoutTime(await (await stancesMd("bob", q)).text()));
    // Available before choosing a stance too: fetching counts as the explicit "先に結果を見る" action. The viewer's own stance is omitted.
    const fm = parseBlocks(await (await stancesMd("bob", q)).text())[0].fm;
    expect(fm).toMatchObject({ total: 1, counts: { agree: 1, disagree: 0, neither: 0 }, total_langs: 1 });
    expect(Object.keys(fm).some((k) => /^(stance|my|own|position|mine)/.test(k))).toBe(false);
  });
});
