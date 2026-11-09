import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, profiles, reasonSelections, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import type { Lang } from "~/lib/languages";
import { pickReasons, reasonsSeed, seededRandom, type ReasonCandidate, type ReasonPick } from "~/lib/reasons";
import { loadReasonCandidates, loadReasonExcerpts, loadReasonsPanel, REASON_EXCERPT_CHARS } from "~/lib/reasons.server";
import { getEntryViews } from "~/lib/entries.server";
import { POSITIONS, type Position } from "~/lib/stances";
import { setStance } from "~/lib/stances.server";
import { loadReactions, setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The reasons panel: up to three tagged replies per position, drawn so that the languages the replies were written in do not repeat, the same for every reader,
// from a seed made of the question and the UTC date.
const cand = (entryId: number, authorId: string, lang: Lang, position: Position, insightful = false): ReasonCandidate => ({ entryId, authorId, lang, position, insightful });
const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const run = (candidates: readonly ReasonCandidate[], seed: number, slots?: number): ReasonPick => pickReasons(candidates, { rng: seededRandom(seed), slots });
const all = (pick: ReasonPick) => POSITIONS.flatMap((p) => pick[p]);

describe("pickReasons", () => {
  it("fills at most three slots for each position, and as many as there are writers when there are fewer", () => {
    const candidates = [
      ...[1, 2, 3, 4, 5].map((i) => cand(i, `a${i}`, "ja", "agree")),
      cand(6, "b1", "en", "disagree"),
      cand(7, "b2", "en", "disagree"),
    ];
    for (const seed of SEEDS.slice(0, 50)) {
      const pick = run(candidates, seed);
      expect(pick.agree).toHaveLength(3);
      expect(pick.disagree).toHaveLength(2);
      expect(pick.neither).toEqual([]);
    }
    expect(run([], 1)).toEqual({ agree: [], disagree: [], neither: [] });
    // the number of slots is a parameter (the panel uses REASON_SLOTS = 3)
    expect(run(candidates, 1, 1).agree).toHaveLength(1);
  });

  it("does not repeat a language within a position while a language that is not shown yet remains (ja 5 writers, en 1, fr 1: the three slots are ja, en and fr)", () => {
    const candidates = [...[1, 2, 3, 4, 5].map((i) => cand(i, `a${i}`, "ja", "agree")), cand(6, "b", "en", "agree"), cand(7, "c", "fr", "agree")];
    const langOf = new Map(candidates.map((c) => [c.entryId, c.lang]));
    for (const seed of SEEDS) {
      const langs = run(candidates, seed).agree.map((id) => langOf.get(id));
      expect([...langs].sort(), `seed ${seed}`).toEqual(["en", "fr", "ja"]);
    }
  });

  it("fills with writers not shown yet when the languages run out (ja only: three different writers; ja and en: both languages first, then another ja writer)", () => {
    const onlyJa = [1, 2, 3, 4, 5].map((i) => cand(i, `a${i}`, "ja", "agree"));
    for (const seed of SEEDS.slice(0, 100)) {
      const authors = run(onlyJa, seed).agree.map((id) => onlyJa.find((c) => c.entryId === id)!.authorId);
      expect(new Set(authors).size).toBe(3);
    }
    const mixed = [...onlyJa, cand(6, "b", "en", "agree")];
    for (const seed of SEEDS.slice(0, 100)) {
      const pick = run(mixed, seed).agree;
      const langs = pick.map((id) => mixed.find((c) => c.entryId === id)!.lang);
      expect(langs.slice(0, 2).sort()).toEqual(["en", "ja"]);
      expect(langs[2]).toBe("ja");
      expect(new Set(pick.map((id) => mixed.find((c) => c.entryId === id)!.authorId)).size).toBe(3);
    }
  });

  it("draws the language with equal probability, however many writers a language has (10 ja writers and 1 en writer: the first slot is en about half of the time)", () => {
    const candidates = [...Array.from({ length: 10 }, (_, i) => cand(i + 1, `a${i}`, "ja" as Lang, "agree" as Position)), cand(11, "b", "en", "agree")];
    const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);
    const en = seeds.filter((seed) => run(candidates, seed).agree[0] === 11).length;
    expect(en / seeds.length).toBeGreaterThan(0.44);
    expect(en / seeds.length).toBeLessThan(0.56);
  });

  it("draws the writer with equal probability, however many replies a writer has (one writer with 10 replies and one with 1: the first slot is the second writer's about half of the time)", () => {
    const candidates = [...Array.from({ length: 10 }, (_, i) => cand(i + 1, "many", "ja" as Lang, "agree" as Position)), cand(11, "one", "ja", "agree")];
    const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);
    const one = seeds.filter((seed) => run(candidates, seed).agree[0] === 11).length;
    expect(one / seeds.length).toBeGreaterThan(0.44);
    expect(one / seeds.length).toBeLessThan(0.56);
    // then one of that writer's replies, with equal probability
    const picks = new Set(seeds.slice(0, 300).map((seed) => run(candidates.slice(0, 10), seed).agree[0]));
    expect(picks.size).toBe(10);
  });

  it("draws the slots after the languages have run out by writer, not by reply (ja only: one writer with 10 replies and four writers with 1 each; each writer has about the same share of the 3 slots)", () => {
    const candidates = [...Array.from({ length: 10 }, (_, i) => cand(i + 1, "many", "ja" as Lang, "agree" as Position)), ...[1, 2, 3, 4].map((i) => cand(10 + i, `one${i}`, "ja", "agree"))];
    const authorOf = new Map(candidates.map((c) => [c.entryId, c.authorId]));
    const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);
    const shown = new Map<string, number>();
    for (const seed of seeds) for (const id of run(candidates, seed).agree) shown.set(authorOf.get(id)!, (shown.get(authorOf.get(id)!) ?? 0) + 1);
    // five writers share three slots: each is shown in 3/5 of the draws
    expect([...shown.keys()].sort()).toEqual(["many", "one1", "one2", "one3", "one4"]);
    for (const [writer, count] of shown) {
      expect(count / seeds.length, writer).toBeGreaterThan(0.54);
      expect(count / seeds.length, writer).toBeLessThan(0.66);
    }
  });

  it("draws the reply within the chosen language (a writer who wrote in ja and in en: the language that was drawn is the language shown)", () => {
    // w1 wrote in ja and in en; w2 wrote in ja. A language is drawn first: en is w1's en reply, ja is w1's ja reply or w2's. So the first slot is en half of the time.
    const candidates = [cand(1, "w1", "ja", "agree"), cand(2, "w1", "en", "agree"), cand(3, "w2", "ja", "agree")];
    const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);
    const en = seeds.filter((seed) => run(candidates, seed, 1).agree[0] === 2).length;
    expect(en / seeds.length).toBeGreaterThan(0.44);
    expect(en / seeds.length).toBeLessThan(0.56);
    // a reply is never taken from a language other than the drawn one: the replies shown are in the languages that were still to show
    const withOthers = [cand(1, "w1", "ja", "agree"), cand(2, "w1", "en", "agree"), cand(3, "w2", "ja", "agree"), cand(4, "w3", "en", "agree")];
    const langOf = new Map(withOthers.map((c) => [c.entryId, c.lang]));
    for (const seed of seeds.slice(0, 400)) {
      expect(run(withOthers, seed, 2).agree.map((id) => langOf.get(id)).sort(), `seed ${seed}`).toEqual(["en", "ja"]);
    }
    const threeLanguages = [cand(1, "w1", "ja", "agree"), cand(2, "w1", "en", "agree"), cand(3, "w2", "fr", "agree"), cand(4, "w3", "ja", "agree"), cand(5, "w4", "en", "agree")];
    const langOf3 = new Map(threeLanguages.map((c) => [c.entryId, c.lang]));
    for (const seed of seeds.slice(0, 400)) {
      expect(run(threeLanguages, seed, 3).agree.map((id) => langOf3.get(id)).sort(), `seed ${seed}`).toEqual(["en", "fr", "ja"]);
    }
  });

  it("draws the order of the positions by lot: a writer tagged under two positions appears under each about half of the time (under three, a third of the time each)", () => {
    const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);
    const two = [cand(1, "w1", "ja", "agree"), cand(2, "w1", "ja", "disagree")];
    const underAgree = seeds.filter((seed) => run(two, seed).agree.length === 1).length;
    expect(underAgree / seeds.length).toBeGreaterThan(0.44);
    expect(underAgree / seeds.length).toBeLessThan(0.56);
    // shown once either way
    for (const seed of seeds.slice(0, 200)) expect(all(run(two, seed))).toHaveLength(1);
    const three = POSITIONS.map((position, i) => cand(i + 1, "w1", "ja", position));
    for (const position of POSITIONS) {
      const share = seeds.filter((seed) => run(three, seed)[position].length === 1).length / seeds.length;
      expect(share, position).toBeGreaterThan(0.29);
      expect(share, position).toBeLessThan(0.38);
    }
  });

  it("never shows a writer twice in the whole panel (a writer who wrote for agree, disagree and neither appears once)", () => {
    const candidates = [
      cand(1, "w1", "ja", "agree"),
      cand(2, "w1", "ja", "disagree"),
      cand(3, "w1", "ja", "neither"),
      cand(4, "w2", "ja", "agree"),
      cand(5, "w2", "ja", "disagree"),
      cand(6, "w2", "ja", "neither"),
      cand(7, "w3", "en", "agree"),
    ];
    const authorOf = new Map(candidates.map((c) => [c.entryId, c.authorId]));
    for (const seed of SEEDS) {
      const authors = all(run(candidates, seed)).map((id) => authorOf.get(id));
      expect(new Set(authors).size, `seed ${seed}`).toBe(authors.length);
      // three writers exist, so the whole panel has three replies
      expect(authors).toHaveLength(3);
    }
  });

  it("counts zh-Hans and zh-Hant as two languages (two slots from zh-Hans, zh-Hant and zh-Hans writers are one of each)", () => {
    const candidates = [cand(1, "a", "zh-Hans", "agree"), cand(2, "b", "zh-Hant", "agree"), cand(3, "c", "zh-Hans", "agree"), cand(4, "d", "zh-Hant", "agree"), cand(5, "e", "zh-Hans", "agree")];
    for (const seed of SEEDS.slice(0, 100)) {
      const langs = run(candidates, seed, 2).agree.map((id) => candidates.find((c) => c.entryId === id)!.lang);
      expect([...langs].sort()).toEqual(["zh-Hans", "zh-Hant"]);
    }
  });

  it("gives the same result for the same seed whatever order the candidates arrive in", () => {
    const candidates = [
      ...[1, 2, 3, 4].map((i) => cand(i, `a${i}`, "ja", "agree")),
      ...[5, 6].map((i) => cand(i, `b${i}`, "en", "agree")),
      ...[7, 8, 9].map((i) => cand(i, `c${i}`, "fr", "disagree")),
      cand(10, "d", "ko", "neither"),
    ];
    for (const seed of SEEDS.slice(0, 60)) {
      const expected = run(candidates, seed);
      expect(run([...candidates].reverse(), seed), `seed ${seed}`).toEqual(expected);
      expect(run([...candidates.slice(5), ...candidates.slice(0, 5)], seed)).toEqual(expected);
    }
  });

  it("keeps languages ahead of Insightful: three pressed Japanese writers and one unpressed English writer fill two Japanese slots and one English slot", () => {
    const candidates = [...[1, 2, 3].map((id) => cand(id, `ja${id}`, "ja", "agree", true)), cand(4, "en", "en", "agree")];
    for (const seed of SEEDS) {
      const pick = run(candidates, seed).agree;
      expect(pick).toHaveLength(3);
      expect(pick).toContain(4);
      expect(pick.filter((id) => id < 4)).toHaveLength(2);
    }
  });

  it("draws languages equally before looking at Insightful, with ten pressed Japanese writers and one unpressed English writer", () => {
    const candidates = [...Array.from({ length: 10 }, (_, i) => cand(i + 1, `ja${i}`, "ja", "agree", true)), cand(11, "en", "en", "agree")];
    const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);
    const share = seeds.filter((seed) => run(candidates, seed).agree[0] === 11).length / seeds.length;
    expect(share).toBeGreaterThan(0.44);
    expect(share).toBeLessThan(0.56);
  });

  it("prefers a pressed reply within the chosen language and still shows an unpressed language", () => {
    const candidates = [cand(1, "pressed", "en", "agree", true), ...[2, 3, 4].map((id) => cand(id, `en${id}`, "en", "agree")), cand(5, "ja", "ja", "agree")];
    for (const seed of SEEDS) {
      const pick = run(candidates, seed).agree;
      expect(pick).toContain(1);
      expect(pick).toContain(5);
      expect(pick.filter((id) => [2, 3, 4].includes(id))).toHaveLength(1);
    }
    // A pressed writer's unpressed reply is outside the preferred pool too.
    const sameWriter = [cand(1, "pressed", "en", "agree", true), cand(2, "pressed", "en", "agree"), cand(3, "other", "en", "agree")];
    for (const seed of SEEDS) expect(run(sameWriter, seed).agree).toEqual([1, 3]);
  });

  it("prefers remaining pressed writers after languages run out, then fills the spare slots", () => {
    const candidates = [1, 2, 3, 4, 5, 6, 7].map((id) => cand(id, `ja${id}`, "ja", "agree", id <= 2));
    for (const seed of SEEDS) {
      const pick = run(candidates, seed).agree;
      expect([...pick.slice(0, 2)].sort()).toEqual([1, 2]);
      expect(pick[2]).toBeGreaterThan(2);
      const single = run(candidates.map((c) => ({ ...c, insightful: c.entryId === 1 })), seed).agree;
      expect(single[0]).toBe(1);
      expect(new Set(single).size).toBe(3);
    }
  });

  it("never repeats a pressed writer across stances", () => {
    const candidates = [cand(1, "shared", "ja", "agree", true), cand(2, "shared", "ja", "disagree", true), cand(3, "other", "en", "agree")];
    for (const seed of SEEDS) {
      const ids = all(run(candidates, seed));
      expect(ids.filter((id) => id === 1 || id === 2)).toHaveLength(1);
      expect(ids).toContain(3);
    }
  });

  it("is deterministic and independent of input order when Insightful is mixed", () => {
    const candidates = [1, 2, 3, 4, 5, 6, 7].map((id) => cand(id, `w${id}`, id % 2 ? "ja" : "en", POSITIONS[id % 3], id % 3 === 0));
    for (const seed of SEEDS) {
      const expected = run(candidates, seed);
      expect(run(candidates, seed)).toEqual(expected);
      expect(run([...candidates].reverse(), seed)).toEqual(expected);
      expect(run([...candidates.slice(3), ...candidates.slice(0, 3)], seed)).toEqual(expected);
    }
  });

  it("keeps the same draws and RNG calls when all candidates are unpressed or all are pressed", () => {
    const candidates = [1, 2, 3, 4, 5, 6, 7].map((id) => cand(id, `w${id % 5}`, id % 2 ? "ja" : "en", POSITIONS[id % 3]));
    for (const seed of SEEDS) {
      const measured = (input: ReasonCandidate[]) => {
        const rng = seededRandom(seed);
        let calls = 0;
        const pick = pickReasons(input, { rng: () => { calls++; return rng(); } });
        return { pick, calls };
      };
      expect(measured(candidates.map((c) => ({ ...c, insightful: true })))).toEqual(measured(candidates));
    }
  });

  it("has no input about the reader or the writer's home area: the types leave no place for them", () => {
    const asCandidate = (c: ReasonCandidate) => c;
    const contract = () => [
      // @ts-expect-error: a candidate has the language of the reply, not the writer's home area
      asCandidate({ entryId: 1, authorId: "a", lang: "ja", position: "agree", insightful: false, writerArea: "ja" }),
      // @ts-expect-error: there is no argument for the reader (language, area or stance)
      pickReasons([], { rng: Math.random, readerArea: "ja" }),
      // @ts-expect-error: there is no argument for the reader's own stance
      pickReasons([], { rng: Math.random, viewerStance: "agree" }),
      // @ts-expect-error: no numeric Insightful count is part of a candidate
      asCandidate({ entryId: 1, authorId: "a", lang: "ja", position: "agree", insightful: false, insightfulCount: 9 }),
      // @ts-expect-error: the Insightful signal is boolean, not a count
      asCandidate({ entryId: 1, authorId: "a", lang: "ja", position: "agree", insightful: 9 }),
      pickReasons([], { rng: Math.random }),
    ];
    expect(typeof contract).toBe("function");
    // the function takes a list and the generator only
    expect(pickReasons.length).toBe(2);
  });
});

describe("reasonsSeed and seededRandom", () => {
  const d = (iso: string) => new Date(iso);

  it("is the same for the same question and UTC date, and differs between questions", () => {
    expect(reasonsSeed(12, d("2026-10-05T00:00:00Z"))).toBe(reasonsSeed(12, d("2026-10-05T23:59:59.999Z")));
    expect(reasonsSeed(12, d("2026-10-05T10:00:00Z"))).not.toBe(reasonsSeed(13, d("2026-10-05T10:00:00Z")));
    expect(Number.isInteger(reasonsSeed(12, d("2026-10-05T10:00:00Z")))).toBe(true);
    // FNV-1a (32 bits) of "<id>:<YYYY-MM-DD>": a known value, so that the rule can be checked from the outside
    expect(reasonsSeed(1, d("2026-01-01T00:00:00Z"))).toBe(fnv1a("1:2026-01-01"));
    expect(reasonsSeed(12, d("2026-10-05T10:00:00Z"))).toBe(fnv1a("12:2026-10-05"));
  });

  it("changes at 00:00 UTC, not at a local midnight", () => {
    expect(reasonsSeed(12, d("2026-10-05T23:59:59Z"))).not.toBe(reasonsSeed(12, d("2026-10-06T00:00:00Z")));
    // 23:59:59 on the 5th in UTC-9 is 08:59:59 on the 6th in UTC: the date is the UTC one
    expect(reasonsSeed(12, d("2026-10-05T23:59:59-09:00"))).toBe(reasonsSeed(12, d("2026-10-06T08:00:00Z")));
    // 00:00:00 on the 6th in UTC+9 is 15:00:00 on the 5th in UTC
    expect(reasonsSeed(12, d("2026-10-06T00:00:00+09:00"))).toBe(reasonsSeed(12, d("2026-10-05T15:00:00Z")));
  });

  it("makes the panel change from day to day when there are more candidates than slots, and not stay on one result", () => {
    const candidates = [...Array.from({ length: 6 }, (_, i) => cand(i + 1, `a${i}`, "ja" as Lang, "agree" as Position)), ...Array.from({ length: 6 }, (_, i) => cand(i + 7, `b${i}`, "en" as Lang, "agree" as Position))];
    const results = new Set<string>();
    for (let day = 1; day <= 20; day++) {
      const seed = reasonsSeed(7, new Date(Date.UTC(2026, 9, day)));
      results.add(JSON.stringify(run(candidates, seed)));
    }
    expect(results.size).toBeGreaterThan(5);
  });

  it("gives the panel of the page tests the same replies on every day of the year (the page tests must not depend on the date of the lot): a lone writer's reply is always shown", () => {
    // jp1 and en1 for agree, fr1 for disagree, and a fourth member (no other tagged reply) for neither: nothing is left to the lot except the order
    const candidates = [cand(1, "jp1", "ja", "agree"), cand(2, "en1", "en", "agree"), cand(3, "fr1", "fr", "disagree"), cand(4, "fan", "en", "neither")];
    for (let day = 0; day < 366; day++) {
      const now = new Date(Date.UTC(2026, 0, 1 + day));
      for (const questionId of [1, 2, 7, 31]) {
        const pick = pickReasons(candidates, { rng: seededRandom(reasonsSeed(questionId, now)) });
        expect({ agree: [...pick.agree].sort(), disagree: pick.disagree, neither: pick.neither }, `${now.toISOString()} q${questionId}`).toEqual({ agree: [1, 2], disagree: [3], neither: [4] });
      }
    }
  });

  it("is a deterministic generator in [0, 1)", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(95);
    expect(seededRandom(43)()).not.toBe(seededRandom(42)());
  });
});

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

async function world() {
  const db = await createTestDb();
  await addMember(db, "hana", "hana", { homeArea: "ja" });
  const members = ["jp1", "jp2", "jp3", "en1", "en2", "fr1", "zh1", "zh2", "viewer", "mod", "op"] as const;
  const area: Record<string, Lang> = { jp1: "ja", jp2: "ja", jp3: "ja", en1: "en", en2: "en", fr1: "fr", zh1: "zh-Hans", zh2: "zh-Hant", viewer: "ko", mod: "ja", op: "ja" };
  for (const id of members) await addMember(db, id, id === "mod" ? "moriko" : id, { homeArea: area[id], readLangs: [area[id]] });
  const q = await createTopic(db, "hana", { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true });
  if (!q.ok) throw new Error("question failed");
  return { db, q: q.id };
}
type World = Awaited<ReturnType<typeof world>>;
const reply = async (w: World, author: string, lang: Lang, tag: Position | "objection" | null, body = `reply ${author} ${lang} ${tag}`) => {
  const res = await createReply(w.db, author, w.q, { lang, body, stanceTag: tag });
  if (!res.ok) throw new Error(`reply failed: ${res.error}`);
  return res.id;
};

describe("loadReasonCandidates", () => {
  it("takes the replies marked agree, disagree or neither, with the language the reply row has (not the writer's home area), and nothing else", async () => {
    const w = await world();
    // jp1's home area is ja, but this reply was written in English: it is an English reply
    const english = await reply(w, "jp1", "en", "agree");
    const japanese = await reply(w, "jp2", "ja", "disagree");
    await reply(w, "en1", "en", "objection");
    await reply(w, "en2", "en", null);
    const candidates = await loadReasonCandidates(w.db, w.q);
    expect(candidates.map((c) => c.entryId).sort((a, b) => a - b)).toEqual([english, japanese]);
    expect(candidates.find((c) => c.entryId === english)).toEqual({ entryId: english, authorId: "jp1", lang: "en", position: "agree", insightful: false });
    expect(candidates.find((c) => c.entryId === japanese)).toEqual({ entryId: japanese, authorId: "jp2", lang: "ja", position: "disagree", insightful: false });
    for (const c of candidates) expect(Object.keys(c).sort()).toEqual(["authorId", "entryId", "insightful", "lang", "position"]);
  });

  it("matches the displayed total's nonzero signal through presses, undoing and voter exclusion", async () => {
    const w = await world();
    const one = await reply(w, "jp1", "ja", "agree");
    const many = await reply(w, "jp2", "ja", "agree");
    const check = async (expected: boolean[]) => {
      const candidates = await loadReasonCandidates(w.db, w.q);
      const reactions = await loadReactions(w.db, [{ id: one }, { id: many }], null);
      expect([one, many].map((id) => candidates.find((c) => c.entryId === id)!.insightful)).toEqual(expected);
      for (const c of candidates) expect(c.insightful).toBe(reactions.get(c.entryId)!.insightful.total > 0);
    };
    await check([false, false]);
    expect(await setVote(w.db, "viewer", one, true)).toMatchObject({ ok: true });
    for (const voter of ["viewer", "en1", "fr1"]) expect(await setVote(w.db, voter, many, true)).toMatchObject({ ok: true });
    await check([true, true]);
    await setVote(w.db, "viewer", one, false);
    await check([false, true]);
    await setVote(w.db, "viewer", one, true);
    await w.db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "viewer"));
    await check([false, true]);
    await w.db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "viewer"));
    await check([true, true]);
  });

  it("leaves out hidden and deleted replies, and the replies of a member under exclude_reactions; they come back when the exclusion is taken off", async () => {
    const w = await world();
    const kept = await reply(w, "jp1", "ja", "agree");
    const hidden = await reply(w, "jp2", "ja", "agree");
    const deleted = await reply(w, "jp3", "ja", "agree");
    const excluded = await reply(w, "en1", "en", "agree");
    await w.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden));
    await w.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, deleted));
    await w.db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "en1"));
    expect((await loadReasonCandidates(w.db, w.q)).map((c) => c.entryId)).toEqual([kept]);
    await w.db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "en1"));
    expect((await loadReasonCandidates(w.db, w.q)).map((c) => c.entryId).sort((a, b) => a - b)).toEqual([kept, excluded]);
    // a member can have more than one reply: all of them are candidates (the writer is chosen first, then one of the replies)
    const second = await reply(w, "jp1", "ja", "disagree");
    expect((await loadReasonCandidates(w.db, w.q)).filter((c) => c.authorId === "jp1").map((c) => c.entryId).sort((a, b) => a - b)).toEqual([kept, second]);
  });

  it("is empty for a hidden or a deleted question, and for a topic that is not a question", async () => {
    const w = await world();
    await reply(w, "jp1", "ja", "agree");
    await w.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, w.q));
    expect(await loadReasonCandidates(w.db, w.q)).toEqual([]);
    await w.db.update(entries).set({ hiddenAt: null, deletedAt: new Date() }).where(eq(entries.id, w.q));
    expect(await loadReasonCandidates(w.db, w.q)).toEqual([]);
    const plain = await createTopic(w.db, "hana", { lang: "ja", title: "普通の話題", body: "本文" });
    if (!plain.ok) throw new Error("topic failed");
    expect(await loadReasonCandidates(w.db, plain.id)).toEqual([]);
    expect(await loadReasonCandidates(w.db, 987654)).toEqual([]);
  });
});

describe("loadReasonsPanel", () => {
  const viewers = {
    member: { userId: "viewer", scope: { operator: false, langs: [] as Lang[] } },
    moderator: { userId: "mod", scope: { operator: false, langs: ["ja"] as Lang[] } },
    operator: { userId: "op", scope: { operator: true, langs: [] as Lang[] } },
  };
  const NOW = new Date("2026-10-05T10:00:00Z");

  async function manyReasons(w: World) {
    for (const [author, lang] of [["jp1", "ja"], ["jp2", "ja"], ["jp3", "ja"], ["en1", "en"], ["en2", "en"], ["fr1", "fr"], ["zh1", "zh-Hans"], ["zh2", "zh-Hant"]] as const) {
      await reply(w, author, lang, "agree");
    }
    // the same members also wrote for the other positions
    for (const [author, lang] of [["jp1", "ja"], ["en1", "en"], ["fr1", "fr"], ["zh1", "zh-Hans"]] as const) await reply(w, author, lang, "disagree");
  }

  it("gives every reader the same replies in the same slots: a member, a moderator and an operator, with different stances and different languages", async () => {
    const w = await world();
    await manyReasons(w);
    await setStance(w.db, "viewer", { questionId: w.q, position: "disagree", expectedVersion: 0 });
    await setStance(w.db, "mod", { questionId: w.q, position: "agree", expectedVersion: 0 });
    const picks = await Promise.all(Object.values(viewers).map((viewer) => loadReasonsPanel(w.db, w.q, { viewer, now: NOW })));
    expect(picks[1].pick).toEqual(picks[0].pick);
    expect(picks[2].pick).toEqual(picks[0].pick);
    expect([...picks[1].views.keys()]).toEqual([...picks[0].views.keys()]);
    // up to three slots per position, and the three positions are the keys, in the fixed order
    expect(Object.keys(picks[0].pick)).toEqual(["agree", "disagree", "neither"]);
    expect(picks[0].pick.agree).toHaveLength(3);
    expect(picks[0].pick.disagree).toHaveLength(3);
    expect(picks[0].pick.neither).toEqual([]);
    // the picked replies are the rows' own (language, handle, html)
    for (const id of all(picks[0].pick)) expect(picks[0].views.get(id)).toMatchObject({ kind: "reply", visibility: "visible" });
    // no writer twice in the whole panel
    const authors = all(picks[0].pick).map((id) => picks[0].views.get(id)!.authorId);
    expect(new Set(authors).size).toBe(authors.length);
  });

  it("stores the first draw for the whole UTC day and defers new replies until the next day", async () => {
    const w = await world();
    await manyReasons(w);
    const at = (iso: string) => loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: new Date(iso) });
    const morning = (await at("2026-10-05T00:00:00Z")).pick;
    expect((await at("2026-10-05T23:59:59Z")).pick).toEqual(morning);
    expect((await at("2026-10-05T12:00:00Z")).pick).toEqual(morning);
    const days = new Set<string>();
    for (let day = 1; day <= 14; day++) days.add(JSON.stringify((await at(`2026-10-${String(day).padStart(2, "0")}T12:00:00Z`)).pick));
    expect(days.size).toBeGreaterThan(1);
    // New replies cannot displace today's draw, including for another reader.
    const added = await reply(w, "viewer", "ko", "agree");
    const after = await at("2026-10-05T12:00:00Z");
    expect(after.pick).toEqual(morning);
    expect((await loadReasonsPanel(w.db, w.q, { viewer: viewers.operator, now: new Date("2026-10-05T23:00:00Z") })).pick).toEqual(morning);
    expect(after.pick.agree.length).toBe(3);
    expect(typeof added).toBe("number");
    const nextDay = new Date("2026-10-15T00:00:00Z");
    const expected = pickReasons(await loadReasonCandidates(w.db, w.q), { rng: seededRandom(reasonsSeed(w.q, nextDay)) });
    expect((await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: nextDay })).pick).toEqual(expected);
  });

  it("freezes the daily draw through presses, undoing and voter exclusion, but explicit seeds and the next day use current presses", async () => {
    const w = await world();
    const ids: number[] = [];
    for (const author of ["jp1", "jp2", "jp3", "en1", "en2"]) ids.push(await reply(w, author, "ja", "agree"));
    const daily = async (now: Date) => (await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now })).pick;
    const morning = await daily(NOW);
    const newlyPressed = ids.find((id) => !morning.agree.includes(id))!;
    await setVote(w.db, "viewer", newlyPressed, true);
    expect(await daily(NOW)).toEqual(morning);
    expect((await loadReasonsPanel(w.db, w.q, { seed: 1 })).pick.agree[0]).toBe(newlyPressed);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const next = await daily(tomorrow);
    expect(next.agree[0]).toBe(newlyPressed);
    await w.db.update(profiles).set({ reactionsExcludedAt: NOW }).where(eq(profiles.userId, "viewer"));
    expect(await daily(tomorrow)).toEqual(next);
    await setVote(w.db, "viewer", newlyPressed, false);
    expect(await daily(tomorrow)).toEqual(next);
    await w.db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "viewer"));
    const another = ids.find((id) => !next.agree.includes(id))!;
    await setVote(w.db, "viewer", another, true);
    expect(await daily(tomorrow)).toEqual(next);
    const thirdDay = await daily(new Date(tomorrow.getTime() + 86_400_000));
    expect(thirdDay.agree[0]).toBe(another);
    expect((await w.db.select().from(reasonSelections).where(eq(reasonSelections.questionId, w.q)).orderBy(reasonSelections.day)).map((r) => r.pick)).toEqual([morning, next, thirdDay]);
  });

  it("removes newly hidden, deleted, excluded or retagged picks without refilling today's slots", async () => {
    const w = await world();
    await manyReasons(w);
    const before = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW });
    const ids = all(before.pick);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    await w.db.update(entries).set({ hiddenAt: NOW }).where(eq(entries.id, ids[0]));
    await w.db.update(entries).set({ deletedAt: NOW }).where(eq(entries.id, ids[1]));
    await w.db.update(profiles).set({ reactionsExcludedAt: NOW }).where(eq(profiles.userId, before.views.get(ids[2])!.authorId));
    await w.db.update(entries).set({ stanceTag: "objection" }).where(eq(entries.id, ids[3]));
    const after = await loadReasonsPanel(w.db, w.q, { viewer: viewers.operator, now: NOW });
    for (const p of POSITIONS) expect(after.pick[p]).toEqual(before.pick[p].filter((id) => !ids.slice(0, 4).includes(id)));
    expect([...after.views.keys()]).not.toEqual(expect.arrayContaining(ids.slice(0, 4)));
    const stored = await w.db.select().from(reasonSelections).where(eq(reasonSelections.questionId, w.q));
    expect(stored).toHaveLength(1);
    expect(stored[0].pick).toEqual(before.pick);
  });

  it("stores an empty draw too and admits new reasons on the next UTC day", async () => {
    const w = await world();
    const empty = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW });
    const id = await reply(w, "jp1", "ja", "agree");
    expect((await loadReasonsPanel(w.db, w.q, { viewer: viewers.operator, now: NOW })).pick).toEqual(empty.pick);
    expect((await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: new Date(NOW.getTime() + 86_400_000) })).pick.agree).toEqual([id]);
  });

  it("converges concurrent readers to one persistent draw", async () => {
    const w = await world();
    await manyReasons(w);
    const panels = await Promise.all(Array.from({ length: 8 }, () => loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW })));
    for (const panel of panels) expect(panel.pick).toEqual(panels[0].pick);
    const rows = await w.db.select().from(reasonSelections).where(eq(reasonSelections.questionId, w.q));
    expect(rows).toHaveLength(1);
    expect(rows[0].pick).toEqual(panels[0].pick);
  });

  it("does not draw hidden, deleted or excluded replies, and an explicit seed overrides the day's seed", async () => {
    const w = await world();
    await manyReasons(w);
    const first = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW, seed: 5 });
    const same = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: new Date("2027-01-01T00:00:00Z"), seed: 5 });
    expect(same.pick).toEqual(first.pick);
    // hide every drawn reply, exclude one writer: none of them is drawn again
    const drawn = all(first.pick);
    for (const id of drawn.slice(0, 2)) await w.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
    const writer = first.views.get(drawn[2])!.authorId;
    await w.db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, writer));
    const next = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW });
    for (const id of all(next.pick)) {
      expect(drawn.slice(0, 2)).not.toContain(id);
      expect(next.views.get(id)!.authorId).not.toBe(writer);
    }
  });

  it("gives each picked reply its place in the thread, with ?lang= carried over", async () => {
    const w = await world();
    const id = await reply(w, "jp1", "ja", "agree");
    const panel = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW, lang: "en" });
    expect(panel.locations.get(id)).toBe(`/t/${w.q}?lang=en#c-${id}`);
    const plain = await loadReasonsPanel(w.db, w.q, { viewer: viewers.member, now: NOW });
    expect(plain.locations.get(id)).toBe(`/t/${w.q}#c-${id}`);
  });
});

describe("loadReasonExcerpts", () => {
  const viewer = { userId: "viewer", scope: { operator: false, langs: [] as Lang[] } };
  const excerptsOf = async (w: World, ids: number[], readLangs: Lang[], displayLang: Lang) =>
    loadReasonExcerpts(w.db, [...(await getEntryViews(w.db, ids, viewer)).values()], { readLangs, displayLang });

  it("is plain text: no Markdown, no HTML, no footnote marks, whitespace collapsed", async () => {
    const w = await world();
    const id = await reply(w, "jp1", "ja", "agree", "## 見出し\n\n**強い**理由があります[^1]。[リンク](https://example.com/x)も見てください。\n\n[^1]: 脚注の本文\n\n- 項目A\n- 項目B");
    const [excerpt] = [...(await excerptsOf(w, [id], ["ja"], "ja")).values()];
    expect(excerpt).toEqual({ text: "見出し 強い理由があります。リンクも見てください。 項目A 項目B", lang: "ja", truncated: false, translation: null, pending: false });
    expect(excerpt.text).not.toMatch(/[#*\[\]<>]|脚注の本文|https:/);
  });

  it("cuts a long reply at REASON_EXCERPT_CHARS characters with an ellipsis and says it is truncated; a reply of exactly that length is whole", async () => {
    const w = await world();
    const exact = await reply(w, "jp1", "ja", "agree", "あ".repeat(REASON_EXCERPT_CHARS));
    const longer = await reply(w, "jp2", "ja", "agree", "い".repeat(REASON_EXCERPT_CHARS + 1));
    const huge = await reply(w, "jp3", "ja", "agree", `${"う".repeat(5000)}`);
    const out = await excerptsOf(w, [exact, longer, huge], ["ja"], "ja");
    expect(out.get(exact)).toMatchObject({ text: "あ".repeat(REASON_EXCERPT_CHARS), truncated: false });
    expect(out.get(longer)).toMatchObject({ text: `${"い".repeat(REASON_EXCERPT_CHARS)}…`, truncated: true });
    expect(out.get(huge)).toMatchObject({ truncated: true });
    expect(out.get(huge)!.text.length).toBe(REASON_EXCERPT_CHARS + 1);
  });

  it("is the display language's translation when the reader would read one and it exists (with its kind), the original with a pending mark when it does not, and the original when the reader reads the language", async () => {
    const w = await world();
    const id = await reply(w, "jp1", "ja", "agree", "日本語の理由です。");
    const [row] = await w.db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, id));
    // an English reader who does not read Japanese: no translation yet
    expect((await excerptsOf(w, [id], ["en"], "en")).get(id)).toEqual({ text: "日本語の理由です。", lang: "ja", truncated: false, translation: null, pending: true });
    await w.db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "A **reason** in Japanese.", engine: "gemini", model: "m", sourceHash: row.hash });
    expect((await excerptsOf(w, [id], ["en"], "en")).get(id)).toEqual({
      text: "A reason in Japanese.",
      lang: "en",
      truncated: false,
      translation: { kind: "primary", engine: "gemini", model: "m", fallback: false, stale: false },
      pending: false,
    });
    // a reader who reads Japanese gets the original, whatever the display language is
    expect((await excerptsOf(w, [id], ["en", "ja"], "en")).get(id)).toEqual({ text: "日本語の理由です。", lang: "ja", truncated: false, translation: null, pending: false });
  });
});

describe("a writer who tagged replies under two positions (fixed seeds)", () => {
  // jp1 wrote for agree and for neither; en1 wrote for agree. A writer is shown once in the whole panel, under the position the lot gives them first; the other position then has no
  // reply of theirs to show (so a position whose only reason is by such a writer can be empty on a day; an open design point).
  // seed 1: the lot visits neither first and gives jp1 to it, so agree has only en1's reply. seed 2: agree first, so jp1's agree reply and en1's reply are shown and neither is empty.
  const viewer = { userId: "viewer", scope: { operator: false, langs: [] as Lang[] } };

  it("shows the writer once, under the position the seed gives first", async () => {
    const w = await world();
    const agree = await reply(w, "jp1", "ja", "agree");
    const neither = await reply(w, "jp1", "ja", "neither");
    const en = await reply(w, "en1", "en", "agree");
    const one = await loadReasonsPanel(w.db, w.q, { viewer, now: new Date("2026-10-05T10:00:00Z"), seed: 1 });
    expect(one.pick).toEqual({ agree: [en], disagree: [], neither: [neither] });
    const two = await loadReasonsPanel(w.db, w.q, { viewer, now: new Date("2026-10-05T10:00:00Z"), seed: 2 });
    expect([...two.pick.agree].sort((a, b) => a - b)).toEqual([agree, en]);
    expect(two.pick.disagree).toEqual([]);
    expect(two.pick.neither).toEqual([]);
    // the same seeds give the same panels again, and the pure function on the loaded candidates agrees
    expect((await loadReasonsPanel(w.db, w.q, { viewer, now: new Date("2027-03-01T00:00:00Z"), seed: 1 })).pick).toEqual(one.pick);
    expect(pickReasons(await loadReasonCandidates(w.db, w.q), { rng: seededRandom(2) })).toEqual(two.pick);
  });
});

describe("the question page", () => {
  let h: RouteHarness;
  let q: number;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    for (const [handle, area] of [["jp1", "ja"], ["en1", "en"], ["fr1", "fr"], ["fan", "en"], ["foe", "fr"], ["fence", "ko"]] as const) await h.signIn(handle, { homeArea: area, readLangs: [area, "ja"] });
    const question = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true });
    if (!question.ok) throw new Error("question failed");
    q = question.id;
    for (const [author, lang, tag] of [["jp1", "ja", "agree"], ["en1", "en", "agree"], ["fr1", "fr", "disagree"]] as const) {
      const res = await createReply(h.db, h.ids[author], q, { lang, body: `reason of ${author}`, stanceTag: tag });
      if (!res.ok) throw new Error(`reply failed: ${res.error}`);
      ids[author] = res.id;
    }
    await setStance(h.db, h.ids.fan, { questionId: q, position: "agree", expectedVersion: 0 });
    await setStance(h.db, h.ids.foe, { questionId: q, position: "disagree", expectedVersion: 0 });
  });
  afterAll(() => h.restore());

  type Reason = { id: number; lang: string; authorHandle: string; excerpt: { text: string; lang: string; truncated: boolean; translation: unknown; pending: boolean }; reactions: { insightful: { total: number; langs: number }; mine: boolean }; own: boolean; location: string; reviewHref: string | null };
  type Page = { question: { reasons: Record<string, Reason[]> | null } };
  const load = async (as: string, path = `/t/${q}`) => (await (await import("~/routes/topic")).loader(h.args(h.request(path, { as }), { id: String(q) }))) as unknown as Page;

  it("has the three positions in the fixed order for a reader with any stance or none, and the same replies for all of them", async () => {
    const pages = await Promise.all(["fan", "foe", "fence", "hana", "jp1"].map((as) => load(as)));
    for (const page of pages) {
      expect(Object.keys(page.question.reasons!)).toEqual(["agree", "disagree", "neither"]);
      expect(page.question.reasons!.agree.map((r) => r.id).sort((a, b) => a - b)).toEqual([ids.jp1, ids.en1]);
      expect(page.question.reasons!.disagree.map((r) => r.id)).toEqual([ids.fr1]);
      expect(page.question.reasons!.neither).toEqual([]);
    }
    // the drawn order is the same too
    const orders = pages.map((p) => JSON.stringify(Object.values(p.question.reasons!).map((list) => list.map((r) => r.id))));
    expect(new Set(orders).size).toBe(1);
  });

  it("carries, for each reply, its language, handle, plain-text excerpt, Insightful state, whether it is the viewer's own and where it is; no writer's area, no user id", async () => {
    const page = await load("fence");
    const reason = page.question.reasons!.disagree[0];
    expect(Object.keys(reason).sort()).toEqual(["authorHandle", "authorName", "excerpt", "id", "lang", "location", "own", "reactions", "reviewHref"]);
    expect(reason).toMatchObject({ id: ids.fr1, lang: "fr", authorHandle: "fr1", authorName: null, own: false, location: `/t/${q}#c-${ids.fr1}`, reviewHref: null });
    // fence reads Korean and Japanese: a French reply has no translation yet, so the original is shown and marked pending
    expect(reason.excerpt).toEqual({ text: "reason of fr1", lang: "fr", truncated: false, translation: null, pending: true });
    // the writer reads French: the original, no pending mark
    expect((await load("fr1")).question.reasons!.disagree[0].excerpt).toEqual({ text: "reason of fr1", lang: "fr", truncated: false, translation: null, pending: false });
    const text = JSON.stringify(page.question.reasons);
    for (const forbidden of [h.ids.jp1, h.ids.en1, h.ids.fr1, "homeArea", "home_area", "writerArea", "authorId"]) expect(text).not.toContain(forbidden);
    // the writer sees the reply as their own (no Insightful button on it)
    expect((await load("fr1")).question.reasons!.disagree[0].own).toBe(true);
  });

  it("gives a reader who holds a stance the 'Reconsider my stance' link on the replies of the panel, and nobody else", async () => {
    expect((await load("fan")).question.reasons!.agree.every((r) => r.reviewHref === `/t/${q}?review=${r.id}#stance`)).toBe(true);
    expect((await load("fence")).question.reasons!.agree.every((r) => r.reviewHref === null)).toBe(true);
  });

  it("does not show a reply that was hidden after the panel was drawn, nor a question that is hidden (no panel at all)", async () => {
    // Hide a reply already in today's persisted draw; new replies wait until tomorrow.
    expect((await load("fence")).question.reasons!.disagree.map((r) => r.id)).toEqual([ids.fr1]);
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ids.fr1));
    expect((await load("fence")).question.reasons!.disagree).toEqual([]);
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, ids.fr1));
    // an Insightful press on a drawn reply shows in the panel's reply (the same loader value as in the reply list)
    await setVote(h.db, h.ids.fence, ids.en1, true);
    const reason = (await load("fence")).question.reasons!.agree.find((r) => r.id === ids.en1)!;
    expect(reason.reactions).toEqual({ insightful: { total: 1, langs: 1 }, mine: true });
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, q));
    expect((await load("hana")).question.reasons).toBeNull();
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, q));
  });
});
