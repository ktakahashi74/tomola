import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildObservationExport } from "~/lib/exports.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// the operators' screens and the observation export show stance numbers across questions only. Never a question together with the stances of a language area. The operators can read
// the database, so this is not a secret: it is a guard in the screen and a promise of the operators. These tests make the guard hold.
// Before the (pinned) clock of the tests: the routes read the metrics with the current time.
const t = (minutes: number) => new Date(Date.UTC(2026, 8, 29, 0, minutes));
const savedOperators = process.env.OPERATOR_EMAILS;
let h: RouteHarness;
let q1: number;
let q2: number;

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "opal-agg@example.com";
  h = await setupRouteHarness();
  await h.signIn("opal", { homeArea: "ja", email: "opal-agg@example.com" });
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("ja2", { homeArea: "ja" });
  await h.signIn("en1", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("en2", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("th1", { homeArea: "th", readLangs: ["th", "ja"] });
  await h.signIn("watcher", { homeArea: "ja" });
  const topic = async (title: string, at: Date) => {
    const res = await createTopic(h.db, h.ids.hana, { lang: "ja", title, body: "命題です。", asksStance: true }, { now: at });
    if (!res.ok) throw new Error("question failed");
    return res.id;
  };
  q1 = await topic("共生は制御の代替になりうる", t(0));
  q2 = await topic("訓練は止めるべきである", t(1));
  const choose = async (who: string, q: number, position: "agree" | "disagree" | "neither", minute: number) => {
    const res = await setStance(h.db, h.ids[who], { questionId: q, position, expectedVersion: 0 }, { now: t(minute) });
    if (!res.ok) throw new Error(`stance failed: ${res.error}`);
  };
  // q1: ja agree x2, en disagree x2, th neither; q2: ja agree, en disagree: so each area has stances on more than one question
  await choose("hana", q1, "agree", 10);
  await choose("ja2", q1, "agree", 11);
  await choose("en1", q1, "disagree", 12);
  await choose("en2", q1, "disagree", 13);
  await choose("th1", q1, "neither", 14);
  await choose("ja2", q2, "agree", 15);
  await choose("en1", q2, "disagree", 16);
  const reply = await createReply(h.db, h.ids.en1, q1, { lang: "en", body: "My reason", stanceTag: "disagree" }, { now: t(20) });
  if (!reply.ok) throw new Error("reply failed");
  await setVote(h.db, h.ids.ja2, reply.id, true, { now: t(21) });
});
afterAll(() => {
  h.restore();
  if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = savedOperators;
});

// An object that names a question (an id of a question, in any spelling) is where a per-question number could sit.
const QUESTION_KEYS = /^(?:question_?id|questionId|question|questions_by|byQuestion|by_question|q_?id)$/i;
const AREA_KEYS = /^(?:area|areas|byArea|by_area|homeArea|home_area|lang|langs|language)$/i;

// The places in the data where a question and an area appear together in one object (a per-question, per-area number), or where the stances are given by question.
function findQuestionAreaPairs(value: unknown, where = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...findQuestionAreaPairs(v, `${where}[${i}]`)));
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.some((k) => QUESTION_KEYS.test(k)) && keys.some((k) => AREA_KEYS.test(k))) found.push(`${where} has a question and an area together`);
    for (const k of keys) {
      if (QUESTION_KEYS.test(k)) found.push(`${where}.${k} names a question`);
      found.push(...findQuestionAreaPairs((value as Record<string, unknown>)[k], `${where}.${k}`));
    }
  }
  return found;
}

describe("the detector itself (so that a pass means something)", () => {
  it("finds a question next to an area, and lets the aggregated shape through", () => {
    expect(findQuestionAreaPairs({ rows: [{ questionId: 3, area: "ja", agree: 2 }] })).not.toEqual([]);
    expect(findQuestionAreaPairs({ byQuestion: { 3: { ja: 2 } } })).not.toEqual([]);
    expect(findQuestionAreaPairs({ a: [{ question_id: 3 }] })).not.toEqual([]);
    expect(findQuestionAreaPairs({ firstStances: [{ area: "ja", questions: 2, people: 3, counts: { agree: { numerator: 1, denominator: 3, people: 1 } } }] })).toEqual([]);
  });
});

describe("/admin/metrics and /admin/observation: stance numbers are across questions only", () => {
  const get = (route: "admin-metrics" | "admin-observation", as: string) => h.outcome(() => import(`../app/routes/${route}.tsx`).then(async (mod: { loader: (a: never) => unknown }) => (await mod.loader(h.args(h.request(`/${route.replace("-", "/")}`, { as }))))));

  it("have no question id, and no question together with an area, anywhere in the data of an operator, and the stance numbers are there", async () => {
    for (const route of ["admin-metrics", "admin-observation"] as const) {
      const res = await get(route, "opal");
      expect(res.status, route).toBe(200);
      expect(findQuestionAreaPairs(JSON.parse(JSON.stringify(res.value))), route).toEqual([]);
    }
    const metrics = (await get("admin-metrics", "opal")).value as {
      distance: Array<{ a: string; b: string; cells: Array<{ questions: number; people: number; sumDistance: number; mean: number | null }> }>;
      firstStances: Array<{ area: string; questions: number; people: number; counts: Record<string, { numerator: number; denominator: number; people: number }> }>;
    };
    // across the two questions: ja agree x2 (q1: hana, ja2) and ja2 on q2 = 3 first stances in ja; en disagree x3 (q1: en1, en2; q2: en1); th neither x1
    const ja = metrics.firstStances.find((r) => r.area === "ja")!;
    expect(ja).toMatchObject({ questions: 2, people: 2, counts: { agree: { numerator: 3, denominator: 3, people: 2 } } });
    expect(metrics.firstStances.find((r) => r.area === "en")).toMatchObject({ questions: 2, people: 2, counts: { disagree: { numerator: 3, denominator: 3, people: 2 } } });
    // the pair ja and en: both questions have both areas, each at distance 1
    const pair = metrics.distance.find((p) => p.a === "ja" && p.b === "en")!;
    expect(pair.cells.at(-1)).toMatchObject({ questions: 2, sumDistance: 2, mean: 1 });
    // the keys of the aggregated shapes are exact (a new key must be added here on purpose)
    expect(Object.keys(metrics.distance[0].cells[0]).sort()).toEqual(["mean", "people", "questions", "sumDistance"]);
    expect(Object.keys(metrics.firstStances[0]).sort()).toEqual(["area", "counts", "people", "questions"]);
    expect(Object.keys(metrics.firstStances[0].counts.agree).sort()).toEqual(["denominator", "numerator", "people"]);
    // no user id, handle or display name of the members who chose stances
    const text = JSON.stringify(metrics);
    for (const secret of [h.ids.hana, h.ids.ja2, h.ids.en1, h.ids.en2, h.ids.th1, "hana", "ja2", "en1", "en2", "th1"]) expect(text, secret).not.toContain(`"${secret}"`);
  });

  it("are for operators only: a member gets 404, a visitor goes to the login", async () => {
    for (const route of ["admin-metrics", "admin-observation"] as const) {
      const refused = await get(route, "watcher");
      expect(refused, route).toMatchObject({ status: 404 });
      expect(JSON.stringify(refused.value ?? null), route).not.toMatch(/evaluations|qualitySignals|draftEdits/);
      expect(await h.outcome(() => import(`../app/routes/${route}.tsx`).then(async (mod: { loader: (a: never) => unknown }) => (await mod.loader(h.args(h.request(`/${route.replace("-", "/")}`))))))).toMatchObject({ status: 302, location: `/login?next=${encodeURIComponent(`/${route.replace("-", "/")}`)}` });
    }
  });
});

describe("the observation export has the distribution of a question as a member sees it, and nothing per area", () => {
  it("has, in each question, only id, alt_of, created_at and a distribution of total, counts, langs and as_of; no area of the stances", async () => {
    const out = await buildObservationExport(h.db, { model: null, now: new Date("2026-10-06T00:00:00Z"), salt: Buffer.alloc(32, 9) });
    expect(out.questions.map((x) => x.id)).toEqual([q1, q2]);
    for (const question of out.questions) {
      expect(Object.keys(question).sort()).toEqual(["alt_of", "created_at", "distribution", "id"]);
      expect(Object.keys(question.distribution).sort()).toEqual(["as_of", "counts", "langs", "total"]);
    }
    expect(out.questions[0].distribution).toMatchObject({ total: 5, counts: { agree: 2, disagree: 2, neither: 1 }, langs: 3 });
    expect(out.questions[1].distribution).toMatchObject({ total: 2, counts: { agree: 1, disagree: 1, neither: 0 }, langs: 2 });
    expect(findQuestionAreaPairs(JSON.parse(JSON.stringify(out.questions)).map((x: { distribution: unknown }) => x.distribution))).toEqual([]);
  });
});

describe("no screen reads the stances by area (the source is scanned)", () => {
  const routesDir = path.join(process.cwd(), "app", "routes");
  const files = fs.readdirSync(routesDir).filter((f) => /\.(ts|tsx)$/.test(f));

  it("no file under app/routes mentions readAreaDistributions or AreaDistribution, and the two operator pages do not import the distribution reader at all", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(fs.readFileSync(path.join(routesDir, f), "utf8"), f).not.toMatch(/\b(?:readAreaDistributions|AreaDistribution)\b/);
    for (const f of ["admin-metrics.tsx", "admin-observation.tsx", "admin-export.ts"]) {
      expect(files, f).toContain(f);
      expect(fs.readFileSync(path.join(routesDir, f), "utf8"), f).not.toMatch(/distribution\.server/);
    }
  });
});
