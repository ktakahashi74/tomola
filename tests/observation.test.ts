import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { divergences, EMBEDDING_DIM, entries, entryEmbeddings, translations } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { FLAG_JUDGED } from "~/lib/llm/flags";
import { sameVendor, vendorOf } from "~/lib/llm/vendor";
import {
  aiAssistanceByAreaMonth,
  conformityWarnings,
  diversityByAreaMonth,
  divergenceStats,
  getObservation,
  MIN_DIVERSITY_ENTRIES,
  monthsStart,
  previousMonth,
  type DiversityPoint,
} from "~/lib/observation.server";
import { addMember, createTestDb } from "./helpers/db";

// Check observation metrics with fixed, hand-calculable fixtures. Embeddings are axis unit vectors (e_i): two on the same axis have distance 0; two on different axes have distance 1.
// For n items with c_i on axis i, mean pairwise distance = 1 − (Σ c_i² − n) / (n (n − 1)). For n = 5,
//   [1,1,1,1,1] → 1.0　[2,1,1,1] → 0.9　[2,2,1] → 0.8　[3,1,1] → 0.7　[3,2] → 0.6　[4,1] → 0.4　[5] → 0.0
const MODEL = "test-embedding";
const now = new Date("2026-10-15T12:00:00Z");

const axis = (i: number, scale = 1) => Array.from({ length: EMBEDDING_DIM }, (_, k) => (k === i ? scale : 0));

async function world() {
  const db = await createTestDb();
  await addMember(db, "ja1", "hana", { homeArea: "ja" });
  await addMember(db, "en1", "john", { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "th1", "somchai", { homeArea: "th", readLangs: ["th"] });
  return db;
}

// Create embedded posts by language area (author affiliation), month (YYYY-MM), and count per axis.
async function seedMonth(db: Db, author: string, month: string, counts: number[], opts: { model?: string; ai?: string | null } = {}) {
  let day = 1;
  const ids: number[] = [];
  for (const [axisIndex, count] of counts.entries()) {
    for (let k = 0; k < count; k++) {
      const at = new Date(`${month}-${String(day).padStart(2, "0")}T00:00:00Z`);
      day = (day % 27) + 1;
      const res = await createTopic(db, author, { lang: "ja", title: `t ${month} ${axisIndex}-${k}`, body: "b", aiAssistance: opts.ai === undefined ? "none" : opts.ai }, { now: at });
      if (!res.ok) throw new Error("topic failed");
      const [row] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, res.id));
      await db.insert(entryEmbeddings).values({ entryId: res.id, model: opts.model ?? MODEL, dim: EMBEDDING_DIM, embedding: axis(axisIndex, 1), sourceHash: row.h! });
      ids.push(res.id);
    }
  }
  return ids;
}

describe("vendorOf", () => {
  it("maps the engine name to a vendor, and compares two engines", () => {
    expect(vendorOf("gemini")).toBe("google");
    expect(vendorOf("claude")).toBe("anthropic");
    expect(vendorOf("fake")).toBe("fake");
    expect(vendorOf("some-new-engine")).toBe("some-new-engine");
    expect(vendorOf(null)).toBeNull();
    expect(sameVendor("gemini", "gemini")).toBe(true);
    expect(sameVendor("gemini", "claude")).toBe(false);
    expect(sameVendor("fake", "fake")).toBe(true);
    expect(sameVendor("gemini", null)).toBeNull();
  });
});

describe("diversity by area and month", () => {
  it("is the mean pairwise cosine distance of the month's embeddings, per area, and skips months with fewer than 5 entries", async () => {
    const db = await world();
    await seedMonth(db, "ja1", "2026-07", [3, 2]); // 0.6
    await seedMonth(db, "ja1", "2026-08", [1, 1, 1, 1, 1]); // 1.0
    await seedMonth(db, "ja1", "2026-09", [5]); // 0.0
    await seedMonth(db, "ja1", "2026-06", [1, 1, 1, 1]); // Four items: suppress output.
    await seedMonth(db, "en1", "2026-09", [2, 2, 1]); // 0.8
    const points = await diversityByAreaMonth(db, { model: MODEL, now });
    expect(MIN_DIVERSITY_ENTRIES).toBe(5);
    expect(points.map((p) => [p.area, p.month, p.entries, Math.round(p.meanDistance * 1e6) / 1e6])).toEqual([
      ["ja", "2026-07", 5, 0.6],
      ["ja", "2026-08", 5, 1],
      ["ja", "2026-09", 5, 0],
      ["en", "2026-09", 5, 0.8],
    ]);
  });

  it("is also right for vectors that are not axis-aligned and not normalized (45 degrees: distance 1 - cos 45)", async () => {
    const db = await world();
    const ids = await seedMonth(db, "ja1", "2026-09", [2, 3]);
    // Replace three items with vectors at 45 degrees between e1 and e2, with different magnitudes: two on e1 and three in the (e1+e2) direction.
    const diagonal = axis(0, 3).map((v, k) => (k === 1 ? 3 : v));
    for (const id of ids.slice(2)) await db.update(entryEmbeddings).set({ embedding: diagonal }).where(eq(entryEmbeddings.entryId, id));
    for (const id of ids.slice(0, 2)) await db.update(entryEmbeddings).set({ embedding: axis(0, 7) }).where(eq(entryEmbeddings.entryId, id));
    const [point] = await diversityByAreaMonth(db, { model: MODEL, now });
    // Pairs: one e1/e1 pair at distance 0, three diagonal/diagonal pairs at distance 0, and six e1/diagonal pairs at distance 1 − cos45. Mean = 6 (1 − √½) / 10.
    expect(point.meanDistance).toBeCloseTo((6 * (1 - Math.SQRT1_2)) / 10, 5);
  });

  it("leaves out hidden and deleted entries, other models, other months' neighbours and posts without an area", async () => {
    const db = await world();
    const ids = await seedMonth(db, "ja1", "2026-09", [3, 2]); // 0.6
    // Do not count hidden or deleted posts even if embeddings remain; adding posts on the same axis would change 0.6.
    const extra = await seedMonth(db, "ja1", "2026-09", [0, 0, 4]);
    await db.update(entries).set({ hiddenAt: new Date("2026-09-30T00:00:00Z") }).where(eq(entries.id, extra[0]));
    await db.update(entries).set({ deletedAt: new Date("2026-09-30T00:00:00Z") }).where(eq(entries.id, extra[1]));
    await db.update(entries).set({ authorArea: null }).where(eq(entries.id, extra[2]));
    // A row for a different model.
    await seedMonth(db, "ja1", "2026-09", [0, 0, 0, 9], { model: "other-model" });
    const points = await diversityByAreaMonth(db, { model: MODEL, now });
    expect(points).toHaveLength(1);
    // The remaining item (extra[3], axis 2) is added: n = 6, [3,2,1]. Σc² = 14 → 1 − (14 − 6)/30 = 0.7333…
    expect(points[0].entries).toBe(6);
    expect(points[0].meanDistance).toBeCloseTo(1 - (14 - 6) / 30, 6);
    void ids;
  });

  it("covers the last 12 months only", async () => {
    const db = await world();
    await seedMonth(db, "ja1", "2025-09", [3, 2]);
    await seedMonth(db, "ja1", "2025-11", [3, 2]);
    expect(monthsStart(now)).toEqual(new Date("2025-11-01T00:00:00Z"));
    expect((await diversityByAreaMonth(db, { model: MODEL, now })).map((p) => p.month)).toEqual(["2025-11"]);
  });
});

describe("replies under a hidden or a deleted topic", () => {
  it("are left out of diversity, AI assistance and the divergence counts, like the topic itself", async () => {
    const db = await world();
    await seedMonth(db, "ja1", "2026-09", [3, 2]); // 0.6, without AI.
    const topicOf = async (title: string) => {
      const res = await createTopic(db, "en1", { lang: "en", title, body: "b" }, { now: new Date("2026-09-10T00:00:00Z") });
      if (!res.ok) throw new Error("topic failed");
      return res.id;
    };
    const hiddenTopic = await topicOf("will be hidden");
    const deletedTopic = await topicOf("will be deleted");
    const replies: number[] = [];
    for (const [topicId, axisIndex] of [[hiddenTopic, 5], [hiddenTopic, 6], [deletedTopic, 7]] as const) {
      const res = await createReply(db, "ja1", topicId, { lang: "ja", body: "r", aiAssistance: "draft" }, { now: new Date("2026-09-11T00:00:00Z") });
      if (!res.ok) throw new Error("reply failed");
      const [row] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, res.id));
      await db.insert(entryEmbeddings).values({ entryId: res.id, model: MODEL, dim: EMBEDDING_DIM, embedding: axis(axisIndex), sourceHash: row.h! });
      replies.push(res.id);
    }
    // Judgment records for topic-body translation divergence do not count once the topic becomes unreadable.
    const [hiddenRow] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, hiddenTopic));
    await db.insert(translations).values([
      { entryId: hiddenTopic, field: "body", lang: "ja", kind: "primary", text: "p", engine: "gemini", model: "m", sourceHash: hiddenRow.h },
      { entryId: hiddenTopic, field: "body", lang: "ja", kind: "secondary", text: "s", engine: "claude", model: "m", sourceHash: hiddenRow.h, flags: [FLAG_JUDGED] },
    ]);
    await db.insert(divergences).values({ entryId: hiddenTopic, lang: "ja", segmentIdx: 0, severity: "high", note: "n", judgeEngine: "claude", judgeModel: "j" });
    for (const id of [hiddenTopic, deletedTopic]) {
      const [r] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, id));
      await db.insert(entryEmbeddings).values({ entryId: id, model: MODEL, dim: EMBEDDING_DIM, embedding: axis(8), sourceHash: r.h! });
    }
    const ja = (points: DiversityPoint[]) => points.find((p) => p.area === "ja" && p.month === "2026-09")!;
    const before = await getObservation(db, { model: MODEL, now });
    // While the topic is readable, count its replies too: 5 + 3 Japanese posts, three AI-assisted drafts, and one divergence.
    expect(ja(before.diversity).entries).toBe(8);
    expect(before.aiAssistance.find((p) => p.area === "ja")!.counts.draft).toBe(3);
    expect(before.divergence.map((d) => d.records)).toEqual([1]);
    // Hide and delete the topics; their replies remain.
    await db.update(entries).set({ hiddenAt: new Date("2026-09-20T00:00:00Z") }).where(eq(entries.id, hiddenTopic));
    await softDeleteEntry(db, deletedTopic, { now: new Date("2026-09-20T00:00:00Z") });
    // The replies themselves are neither deleted nor hidden, and their embeddings remain. The parent topic's state alone excludes them.
    for (const id of replies) expect((await db.select({ d: entries.deletedAt, h: entries.hiddenAt }).from(entries).where(eq(entries.id, id)))[0]).toEqual({ d: null, h: null });
    const after = await getObservation(db, { model: MODEL, now });
    expect(ja(after.diversity).entries).toBe(5);
    expect(ja(after.diversity).meanDistance).toBeCloseTo(0.6, 6);
    expect(after.aiAssistance.find((p) => p.area === "ja")!.counts.draft).toBe(0);
    expect(after.divergence).toEqual([]);
  });
});

describe("the conformity warning", () => {
  const point = (area: DiversityPoint["area"], month: string, meanDistance: number): DiversityPoint => ({ area, month, entries: 5, meanDistance });

  it("warns for an area whose latest 4 consecutive completed months decline each month (3 declines in a row)", () => {
    const points = [
      point("ja", "2026-06", 1.0),
      point("ja", "2026-07", 0.9),
      point("ja", "2026-08", 0.8),
      point("ja", "2026-09", 0.7),
      // The value rose, so do not warn.
      point("en", "2026-06", 0.9),
      point("en", "2026-07", 1.0),
      point("en", "2026-08", 0.8),
      point("en", "2026-09", 0.7),
      // Only two declines.
      point("fr", "2026-07", 1.0),
      point("fr", "2026-08", 0.9),
      point("fr", "2026-09", 0.8),
      // A month is missing: August has fewer than five items, so no point.
      point("de", "2026-06", 1.0),
      point("de", "2026-07", 0.9),
      point("de", "2026-09", 0.8),
      // Equal values are not a decline.
      point("ko", "2026-06", 0.9),
      point("ko", "2026-07", 0.8),
      point("ko", "2026-08", 0.8),
      point("ko", "2026-09", 0.7),
    ];
    expect(conformityWarnings(points, now).map((w) => w.area)).toEqual(["ja"]);
    expect(conformityWarnings(points, now)[0]).toEqual({ area: "ja", months: ["2026-06", "2026-07", "2026-08", "2026-09"], values: [1.0, 0.9, 0.8, 0.7] });
    // A consecutive series across the year boundary; the latest completed month is 2026-02.
    const across = [point("th", "2025-11", 0.9), point("th", "2025-12", 0.8), point("th", "2026-01", 0.7), point("th", "2026-02", 0.6)];
    expect(conformityWarnings(across, new Date("2026-03-15T00:00:00Z"))).toEqual([{ area: "th", months: ["2025-11", "2025-12", "2026-01", "2026-02"], values: [0.9, 0.8, 0.7, 0.6] }]);
  });

  it("ignores the current, incomplete month and needs the series to end at the last completed month", () => {
    // now is 2026-10-15; the current month, 2026-10, is incomplete.
    const points = [
      // ja: completed months were flat, then declined. A further decline in the current month must not trigger a warning.
      point("ja", "2026-06", 0.9),
      point("ja", "2026-07", 0.95),
      point("ja", "2026-08", 0.9),
      point("ja", "2026-09", 0.85),
      point("ja", "2026-10", 0.1),
      // en: including the current month would suggest four consecutive declining months; completed months alone do not show a continuous decline.
      point("en", "2026-07", 0.9),
      point("en", "2026-08", 1.0),
      point("en", "2026-09", 0.8),
      point("en", "2026-10", 0.7),
      // fr: four completed declining months still trigger a warning when the current month is present; ignore the current month.
      point("fr", "2026-06", 1.0),
      point("fr", "2026-07", 0.9),
      point("fr", "2026-08", 0.8),
      point("fr", "2026-09", 0.7),
      point("fr", "2026-10", 0.99),
      // ko: the four-month decline ends in 2026-08. September has fewer than five items and no point, so the series does not end in the latest completed month.
      point("ko", "2026-05", 1.0),
      point("ko", "2026-06", 0.9),
      point("ko", "2026-07", 0.8),
      point("ko", "2026-08", 0.7),
    ];
    expect(conformityWarnings(points, now).map((w) => w.area)).toEqual(["fr"]);
    // When 2026-10 becomes complete and the current month is 2026-11, the last four months of ja (07-10: 0.95, 0.9, 0.85, 0.1) decline every month.
    expect(conformityWarnings(points, new Date("2026-11-02T00:00:00Z")).map((w) => w.area)).toEqual(["ja"]);
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
  });

  it("is computed from the database series by getObservation", async () => {
    const db = await world();
    await seedMonth(db, "ja1", "2026-06", [1, 1, 1, 1, 1]);
    await seedMonth(db, "ja1", "2026-07", [2, 1, 1, 1]);
    await seedMonth(db, "ja1", "2026-08", [2, 2, 1]);
    await seedMonth(db, "ja1", "2026-09", [3, 1, 1]);
    const obs = await getObservation(db, { model: MODEL, now });
    expect(obs.conformity.map((w) => [w.area, w.months.at(-1), w.values.map((v) => Math.round(v * 100) / 100)])).toEqual([["ja", "2026-09", [1, 0.9, 0.8, 0.7]]]);
    // Without a model, omit diversity metrics.
    expect((await getObservation(db, { model: null, now })).diversity).toEqual([]);
  });
});

describe("AI assistance declarations over time", () => {
  it("counts the declared levels per area and month, and the share of declared use (not none)", async () => {
    const db = await world();
    await seedMonth(db, "ja1", "2026-08", [1], { ai: "none" });
    await seedMonth(db, "ja1", "2026-09", [2], { ai: "none" });
    await seedMonth(db, "ja1", "2026-09", [1], { ai: "polish" });
    await seedMonth(db, "ja1", "2026-09", [1], { ai: "coauthor" });
    await seedMonth(db, "en1", "2026-09", [3], { ai: "draft" });
    const hidden = await seedMonth(db, "en1", "2026-09", [1], { ai: "draft" });
    await db.update(entries).set({ hiddenAt: new Date("2026-09-30T00:00:00Z") }).where(eq(entries.id, hidden[0]));
    const points = await aiAssistanceByAreaMonth(db, { now });
    expect(points.map((p) => [p.area, p.month, p.counts, p.total, p.declaredShare])).toEqual([
      ["ja", "2026-08", { none: 1, polish: 0, draft: 0, coauthor: 0 }, 1, 0],
      ["ja", "2026-09", { none: 2, polish: 1, draft: 0, coauthor: 1 }, 4, 0.5],
      ["en", "2026-09", { none: 0, polish: 0, draft: 3, coauthor: 0 }, 3, 1],
    ]);
  });

  it("counts only the posts that have a value: the share and the total leave the posts without one out, and they are given as a separate number", async () => {
    const db = await world();
    await seedMonth(db, "ja1", "2026-09", [2], { ai: null });
    await seedMonth(db, "ja1", "2026-09", [1], { ai: "none" });
    await seedMonth(db, "ja1", "2026-09", [1], { ai: "polish" });
    // A month and an area where no post states a value: no share, only the number of posts without one.
    await seedMonth(db, "th1", "2026-09", [3], { ai: null });
    const points = await aiAssistanceByAreaMonth(db, { now });
    expect(points.map((p) => [p.area, p.month, p.counts, p.total, p.unstated, p.declaredShare])).toEqual([
      ["ja", "2026-09", { none: 1, polish: 1, draft: 0, coauthor: 0 }, 2, 2, 0.5],
      ["th", "2026-09", { none: 0, polish: 0, draft: 0, coauthor: 0 }, 0, 3, null],
    ]);
  });
});

describe("divergences per language pair, and with the same vendor", () => {
  async function judged(db: Db, entryId: number, lang: string, primary: [string, string], secondary: [string, string], records: string[]) {
    const [e] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, entryId));
    await db.insert(translations).values([
      { entryId, field: "body", lang, kind: "primary", text: "p", engine: primary[0], model: primary[1], sourceHash: e.h },
      { entryId, field: "body", lang, kind: "secondary", text: "s", engine: secondary[0], model: secondary[1], sourceHash: e.h, flags: [FLAG_JUDGED] },
    ]);
    // Records contain severity or severity:category; low:tone denotes a tone difference.
    for (const [i, record] of records.entries()) {
      const [severity, category = "meaning"] = record.split(":");
      await db.insert(divergences).values({ entryId, lang, segmentIdx: i, severity, category, note: "secret note about a sentence", judgeEngine: "claude", judgeModel: "j", sourceHash: e.h });
    }
  }

  it("counts measured translations, records and the severity distribution per pair, with the same-vendor cases separated", async () => {
    const db = await world();
    const make = async (lang: string, title: string) => {
      const res = await createTopic(db, "ja1", { lang, title, body: "b" });
      if (!res.ok) throw new Error("topic failed");
      return res.id;
    };
    const a = await make("ja", "a");
    const b = await make("ja", "b");
    const c = await make("ja", "c");
    const d = await make("en", "d");
    const hiddenTopic = await make("ja", "hidden");
    const g = ["gemini", "gemini-3.1-flash-lite"] as [string, string];
    const g2 = ["gemini", "gemini-3.5-flash-lite"] as [string, string];
    const cl = ["claude", "claude-haiku-4-5"] as [string, string];
    // ja>en: a uses gemini and claude, different providers, with high and low; b uses gemini and gemini, the same provider, with medium.
    await judged(db, a, "en", g, cl, ["high", "low:tone"]);
    await judged(db, b, "en", g, g2, ["medium:tone"]);
    // ja>fr: c uses gemini and gemini, the same provider, with no divergence.
    await judged(db, c, "fr", g, g2, []);
    // en>ja: d uses gemini and claude, with low.
    await judged(db, d, "ja", g, cl, ["low"]);
    // An unmeasured topic with only a primary translation is eligible but not measured. A fallback topic translated by the other lineage is not eligible because it has no comparison partner.
    const e = await make("ja", "e");
    const f = await make("ja", "f");
    const [eRow] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, e));
    const [fRow] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, f));
    await db.insert(translations).values([
      { entryId: e, field: "body", lang: "en", kind: "primary", text: "p", engine: "gemini", model: "gemini-3.1-flash-lite", sourceHash: eRow.h },
      { entryId: f, field: "body", lang: "en", kind: "primary", text: "p", engine: "claude", model: "claude-haiku-4-5", sourceHash: fRow.h, fallback: true },
    ]);
    // Do not count hidden or deleted topics.
    await judged(db, hiddenTopic, "en", g, cl, ["high"]);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hiddenTopic));
    const stats = await divergenceStats(db);
    expect(stats).toEqual([
      {
        from: "ja",
        to: "en",
        eligible: 3,
        measured: 2,
        records: 3,
        // Of these, low and medium are tone differences (category tone).
        tone: 2,
        severity: { low: 1, medium: 1, high: 1 },
        sameVendor: { measured: 1, records: 1, tone: 1, severity: { low: 0, medium: 1, high: 0 } },
      },
      { from: "ja", to: "fr", eligible: 1, measured: 1, records: 0, tone: 0, severity: { low: 0, medium: 0, high: 0 }, sameVendor: { measured: 1, records: 0, tone: 0, severity: { low: 0, medium: 0, high: 0 } } },
      { from: "en", to: "ja", eligible: 1, measured: 1, records: 1, tone: 0, severity: { low: 1, medium: 0, high: 0 }, sameVendor: { measured: 0, records: 0, tone: 0, severity: { low: 0, medium: 0, high: 0 } } },
    ]);
  });

  it("does not count a translation that was not judged, and counts the fake engines as the same vendor", async () => {
    const db = await world();
    const res = await createTopic(db, "ja1", { lang: "ja", title: "t", body: "b" });
    if (!res.ok) throw new Error("topic failed");
    const [e] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, res.id));
    await db.insert(translations).values({ entryId: res.id, field: "body", lang: "en", kind: "secondary", text: "s", engine: "fake", model: "fake-1", sourceHash: e.h });
    expect(await divergenceStats(db)).toEqual([]);
    await judged2(db, res.id, e.h!);
    expect(await divergenceStats(db)).toMatchObject([{ from: "ja", to: "fr", eligible: 1, measured: 1, sameVendor: { measured: 1 } }]);
  });
});

async function judged2(db: Db, entryId: number, hash: string) {
  await db.insert(translations).values([
    { entryId, field: "body", lang: "fr", kind: "primary", text: "p", engine: "fake", model: "fake-1", sourceHash: hash },
    { entryId, field: "body", lang: "fr", kind: "secondary", text: "s", engine: "fake", model: "fake-1", sourceHash: hash, flags: [FLAG_JUDGED] },
  ]);
}
